import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { decodeDocument } from '../domain/decode-document.js';
import { type ProcessingError, ServerError, toProcessingError } from '../domain/errors.js';
import { mapUblOrder } from '../domain/map-ubl-order.js';
import type { TransformedOrderMessage } from '../domain/order.js';
import { parseUblOrder } from '../domain/parse-ubl-order.js';
import {
  type Delivery,
  type InboundMessage,
  parseDelivery,
  peekMessageId,
  validateMessage,
} from './inbound-message.js';
import type { DeliveryTracker, IdempotencyStore, Logger, MessagePublisher } from './ports.js';

export interface OrderProcessorConfig {
  outputTopic: string;
  deadLetterTopic: string;
  /** Attempts (including the first one) before a retryable failure is dead-lettered. */
  maxDeliveryAttempts: number;
}

export interface OrderProcessorDeps {
  publisher: MessagePublisher;
  idempotencyStore: IdempotencyStore;
  deliveryTracker: DeliveryTracker;
  config: OrderProcessorConfig;
  clock?: () => Date;
}

export type ProcessingResult =
  | {
      outcome: 'transformed';
      messageId: string;
      output: TransformedOrderMessage;
      /** True when the output was produced earlier and is only replayed (nothing published). */
      replayed: boolean;
      /**
       * Set on a replay whose document differs from the one originally processed under the
       * same messageId - most likely a partner bug. Only reported, the earlier result stands.
       */
      documentMismatch?: true;
    }
  | {
      outcome: 'rejected';
      messageId: string | null;
      error: ProcessingError;
      attempt: number;
      deadLettered: boolean;
    }
  | {
      /** A Pub/Sub redelivery of a message that has already been moved to the DLQ. */
      outcome: 'already-dead-lettered';
      messageId: string | null;
    };

/** Message published to the dead-letter topic (orders.failed). */
export interface DeadLetterRecord {
  messageId: string | null;
  failedAt: string;
  error: { code: string; message: string; detail?: string };
  deliveryAttempt: number;
  source: Delivery['source'] | 'unknown';
  pubsubMessageId?: string;
  subscription?: string;
  /** The business message (or the raw request body when it could not be extracted). */
  originalMessage: unknown;
}

interface ProcessingContext {
  body: unknown;
  delivery?: Delivery;
  messageId: string | null;
  log: Logger;
}

/**
 * Application service implementing the processing flow:
 * validate -> decode Base64 -> parse XML -> map UBL -> publish,
 * plus the delivery policies around it (idempotency, retries, dead-lettering).
 *
 * It is transport-agnostic: the HTTP layer only translates its result into a response.
 */
export class OrderProcessor {
  private readonly publisher: MessagePublisher;
  private readonly idempotencyStore: IdempotencyStore;
  private readonly deliveryTracker: DeliveryTracker;
  private readonly config: OrderProcessorConfig;
  private readonly clock: () => Date;
  /** Concurrent deliveries of the same messageId share one transformation. */
  private readonly inFlight = new Map<
    string,
    { output: Promise<TransformedOrderMessage>; documentHash: string }
  >();

  constructor(deps: OrderProcessorDeps) {
    this.publisher = deps.publisher;
    this.idempotencyStore = deps.idempotencyStore;
    this.deliveryTracker = deps.deliveryTracker;
    this.config = deps.config;
    this.clock = deps.clock ?? (() => new Date());
  }

  async process(body: unknown, logger: Logger): Promise<ProcessingResult> {
    const startedAt = performance.now();
    const context: ProcessingContext = { body, messageId: null, log: logger };

    let result: ProcessingResult;
    try {
      result = await this.handle(context);
    } catch (error) {
      result = await this.handleFailure(toProcessingError(error), context);
    }

    this.logResult(result, context.log, performance.now() - startedAt);
    return result;
  }

  private async handle(context: ProcessingContext): Promise<ProcessingResult> {
    const delivery = parseDelivery(context.body);
    context.delivery = delivery;
    context.messageId = peekMessageId(delivery.payload);
    context.log = context.log.child({
      messageId: context.messageId,
      source: delivery.source,
      ...(delivery.pubsubMessageId !== undefined && { pubsubMessageId: delivery.pubsubMessageId }),
      ...(delivery.deliveryAttempt !== undefined && { deliveryAttempt: delivery.deliveryAttempt }),
    });

    const message = validateMessage(delivery.payload);
    const { messageId } = message;

    const deliveryKey = this.deliveryKey(context);
    if (
      delivery.source === 'pubsub-push' &&
      deliveryKey !== null &&
      (await this.deliveryTracker.isDeadLettered(deliveryKey))
    ) {
      return { outcome: 'already-dead-lettered', messageId };
    }

    const documentHash = fingerprint(message.document);

    const previous = await this.idempotencyStore.get(messageId);
    if (previous !== undefined) {
      return replay(messageId, previous.output, previous.documentHash !== documentHash);
    }

    const running = this.inFlight.get(messageId);
    if (running !== undefined) {
      return replay(messageId, await running.output, running.documentHash !== documentHash);
    }

    const output = this.transformAndPublish(message, documentHash, context.log);
    this.inFlight.set(messageId, { output, documentHash });
    try {
      return { outcome: 'transformed', messageId, output: await output, replayed: false };
    } finally {
      this.inFlight.delete(messageId);
    }
  }

  private async transformAndPublish(
    message: InboundMessage,
    documentHash: string,
    log: Logger,
  ): Promise<TransformedOrderMessage> {
    const xml = decodeDocument(message.document);
    const { order: ublOrder, warnings } = parseUblOrder(xml);
    for (const warning of warnings) {
      log.warn({ warning }, 'UBL document accepted with a warning');
    }
    const order = mapUblOrder(ublOrder);
    const output: TransformedOrderMessage = {
      messageId: message.messageId,
      transformedAt: formatTimestamp(this.clock()),
      order,
    };

    let publishedId: string;
    try {
      publishedId = await this.publisher.publish(this.config.outputTopic, {
        data: output,
        attributes: { messageId: message.messageId, orderId: order.orderId },
      });
    } catch (error) {
      throw new ServerError(
        `Failed to publish to ${this.config.outputTopic}: ${errorText(error)}`,
        {
          cause: error,
        },
      );
    }
    log.debug({ topic: this.config.outputTopic, publishedId }, 'Transformed order published');

    await this.idempotencyStore.save(message.messageId, { output, documentHash });
    return output;
  }

  /**
   * Retry / dead-letter policy:
   * - non-retryable errors (bad Base64, bad XML, validation) are dead-lettered immediately,
   *   retrying them can never succeed;
   * - retryable errors are dead-lettered once `maxDeliveryAttempts` is reached,
   *   before that the 5xx response makes Pub/Sub redeliver with backoff.
   */
  private async handleFailure(
    error: ProcessingError,
    context: ProcessingContext,
  ): Promise<ProcessingResult> {
    const { messageId } = context;
    try {
      const deliveryKey = this.deliveryKey(context);
      const attempt =
        context.delivery?.deliveryAttempt ??
        (deliveryKey === null ? 1 : await this.deliveryTracker.recordAttempt(deliveryKey));

      const giveUp = !error.retryable || attempt >= this.config.maxDeliveryAttempts;
      if (!giveUp) {
        return { outcome: 'rejected', messageId, error, attempt, deadLettered: false };
      }

      const firstTime =
        deliveryKey === null || !(await this.deliveryTracker.isDeadLettered(deliveryKey));
      if (firstTime) {
        await this.publishDeadLetter(error, context, attempt);
        if (deliveryKey !== null) {
          await this.deliveryTracker.markDeadLettered(deliveryKey);
        }
      }
      return { outcome: 'rejected', messageId, error, attempt, deadLettered: true };
    } catch (dlqError) {
      // The message could not be parked safely: answer 5xx so that Pub/Sub keeps it.
      context.log.error(
        { err: dlqError, originalError: error.code },
        'Failed to dead-letter message',
      );
      return {
        outcome: 'rejected',
        messageId,
        error: new ServerError(`Dead-lettering failed: ${errorText(dlqError)}`, {
          cause: dlqError,
        }),
        attempt: context.delivery?.deliveryAttempt ?? 1,
        deadLettered: false,
      };
    }
  }

  private async publishDeadLetter(
    error: ProcessingError,
    context: ProcessingContext,
    attempt: number,
  ): Promise<void> {
    const { delivery, messageId } = context;
    const record: DeadLetterRecord = {
      messageId,
      failedAt: formatTimestamp(this.clock()),
      error: {
        code: error.code,
        message: error.message,
        ...(error.detail !== undefined && { detail: error.detail }),
      },
      deliveryAttempt: attempt,
      source: delivery?.source ?? 'unknown',
      ...(delivery?.pubsubMessageId !== undefined && { pubsubMessageId: delivery.pubsubMessageId }),
      ...(delivery?.subscription !== undefined && { subscription: delivery.subscription }),
      originalMessage: delivery?.payload ?? context.body,
    };

    await this.publisher.publish(this.config.deadLetterTopic, {
      data: record,
      attributes: { errorCode: error.code, ...(messageId !== null && { messageId }) },
    });
  }

  /**
   * Key identifying one delivered message across retries: Pub/Sub's own message id
   * (stable across redeliveries), or the business messageId for direct calls.
   */
  private deliveryKey(context: ProcessingContext): string | null {
    return context.delivery?.pubsubMessageId ?? context.messageId;
  }

  private logResult(result: ProcessingResult, log: Logger, durationMs: number): void {
    const metrics = { outcome: result.outcome, durationMs: Math.round(durationMs * 100) / 100 };

    switch (result.outcome) {
      case 'transformed': {
        const fields = {
          ...metrics,
          replayed: result.replayed,
          orderId: result.output.order.orderId,
          lineCount: result.output.order.lines.length,
        };
        if (result.documentMismatch) {
          log.warn(
            { ...fields, documentMismatch: true },
            'messageId reused with a different document, earlier result replayed',
          );
        } else {
          log.info(
            fields,
            result.replayed ? 'Duplicate message, earlier result replayed' : 'Order transformed',
          );
        }
        return;
      }
      case 'already-dead-lettered':
        log.info(metrics, 'Redelivery of a dead-lettered message acknowledged');
        return;
      case 'rejected': {
        const { error } = result;
        const fields = {
          ...metrics,
          errorCode: error.code,
          errorMessage: error.message,
          ...(error.detail !== undefined && { errorDetail: error.detail }),
          attempt: result.attempt,
          deadLettered: result.deadLettered,
          ...(error.cause !== undefined && { err: error.cause }),
        };
        if (error.retryable) {
          log.error(fields, 'Message processing failed');
        } else {
          log.warn(fields, 'Message rejected');
        }
      }
    }
  }
}

function replay(
  messageId: string,
  output: TransformedOrderMessage,
  documentMismatch: boolean,
): ProcessingResult {
  return {
    outcome: 'transformed',
    messageId,
    output,
    replayed: true,
    ...(documentMismatch && { documentMismatch: true }),
  };
}

/**
 * SHA-256 of the Base64 document, ignoring line breaks, so the same document encoded with
 * and without MIME line wrapping is not reported as different.
 */
function fingerprint(base64Document: string): string {
  return createHash('sha256')
    .update(base64Document.replace(/[\r\n]/g, ''))
    .digest('hex');
}

/** ISO 8601 UTC timestamp with second precision, e.g. 2026-07-27T12:01:00Z. */
export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
} from 'fastify';
import type { OrderProcessor, ProcessingResult } from '../application/order-processor.js';
import { type ErrorCode, ProcessingError, ValidationError } from '../domain/errors.js';

export const PUSH_ENDPOINT = '/pubsub/push';

export interface AppOptions {
  processor: OrderProcessor;
  logger: FastifyBaseLogger;
  bodyLimitBytes?: number;
  /** Called when the server shuts down (e.g. to flush the publisher). */
  onClose?: () => Promise<void>;
}

export interface ErrorResponse {
  error: ErrorCode;
  message: string;
  messageId: string | null;
}

/**
 * HTTP adapter: Cloud Run receives Pub/Sub push deliveries as POST requests.
 *
 * Status codes double as acknowledgements - Pub/Sub treats 2xx as ack and
 * anything else as nack (redelivery with backoff).
 */
export function buildApp({
  processor,
  logger,
  bodyLimitBytes,
  onClose,
}: AppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    // One structured line per message is logged by the processor instead.
    logController: new LogController({ disableRequestLogging: true }),
    ...(bodyLimitBytes !== undefined && { bodyLimit: bodyLimitBytes }),
  });

  // Accept JSON regardless of the declared content type (e.g. `curl -d @file.json`).
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, body === '' ? undefined : (JSON.parse(body as string) as unknown));
    } catch {
      done(new ValidationError('Message must be a valid JSON document.'), undefined);
    }
  });

  app.get('/healthz', () => ({ status: 'ok' }));

  app.post(PUSH_ENDPOINT, async (request, reply) => {
    const result = await processor.process(request.body, request.log);
    return sendResult(reply, result);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const response = toErrorResponse(error);
    const status = error instanceof ProcessingError ? error.httpStatus : (error.statusCode ?? 500);
    if (status >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
    } else {
      request.log.warn(
        { errorCode: response.error, errorDetail: error.message },
        'Request rejected',
      );
    }
    return reply.code(status).send(response);
  });

  if (onClose !== undefined) {
    app.addHook('onClose', async () => onClose());
  }

  return app;
}

function sendResult(reply: FastifyReply, result: ProcessingResult): FastifyReply {
  switch (result.outcome) {
    case 'transformed':
      if (result.documentMismatch) {
        // Direct callers cannot see our logs; tell them the earlier result was kept.
        void reply.header('x-document-mismatch', 'true');
      }
      return reply
        .code(200)
        .header('x-idempotent-replay', String(result.replayed))
        .send(result.output);
    case 'already-dead-lettered':
      // Acknowledge, so Pub/Sub stops redelivering a message already parked in the DLQ.
      return reply.code(204).send();
    case 'rejected': {
      const body: ErrorResponse = {
        error: result.error.code,
        message: result.error.message,
        messageId: result.messageId,
      };
      return reply.code(result.error.httpStatus).send(body);
    }
  }
}

/** Errors raised by Fastify itself (body parsing, size limit) mapped onto the error contract. */
function toErrorResponse(error: FastifyError): ErrorResponse {
  if (error instanceof ProcessingError) {
    return { error: error.code, message: error.message, messageId: null };
  }
  switch (error.code) {
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return { error: 'ValidationError', message: 'Message is required.', messageId: null };
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return {
        error: 'ValidationError',
        message: 'Message must be a valid JSON document.',
        messageId: null,
      };
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return {
        error: 'ValidationError',
        message: 'Message exceeds the maximum allowed size.',
        messageId: null,
      };
  }
  if (error.statusCode !== undefined && error.statusCode < 500) {
    return { error: 'ValidationError', message: error.message, messageId: null };
  }
  return { error: 'ServerError', message: 'An unexpected error occurred.', messageId: null };
}

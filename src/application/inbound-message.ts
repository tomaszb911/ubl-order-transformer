import { decodeBase64 } from '../domain/decode-document.js';
import { ValidationError } from '../domain/errors.js';

/** The business message published by the partner (see the assignment's sample message). */
export interface InboundMessage {
  messageId: string;
  timestamp?: string;
  /** Base64-encoded UBL 2.1 Order XML. */
  document: string;
}

/**
 * How a message reached the service.
 *
 * - `pubsub-push`: Pub/Sub push subscription. The business message is the JSON
 *   carried (Base64-encoded) in `message.data` of the push envelope.
 * - `direct`: the business message itself was POSTed (local testing, manual replays).
 */
export interface Delivery {
  source: 'pubsub-push' | 'direct';
  /** Pub/Sub's message id - stable across redeliveries of the same Pub/Sub message. */
  pubsubMessageId?: string;
  /** Present only when the subscription has a dead-letter policy configured. */
  deliveryAttempt?: number;
  subscription?: string;
  payload: unknown;
}

/** Identifies the transport envelope and extracts the business payload from it. */
export function parseDelivery(body: unknown): Delivery {
  if (!isRecord(body)) {
    throw new ValidationError('Message is required.');
  }
  if (!('message' in body)) {
    return { source: 'direct', payload: body };
  }

  const { message, subscription, deliveryAttempt } = body;
  if (!isRecord(message)) {
    throw new ValidationError('Message is required.');
  }
  const { data, messageId } = message;
  if (typeof data !== 'string' || data.length === 0) {
    throw new ValidationError('Message is required.');
  }

  return {
    source: 'pubsub-push',
    ...(typeof messageId === 'string' && { pubsubMessageId: messageId }),
    ...(typeof deliveryAttempt === 'number' && { deliveryAttempt }),
    ...(typeof subscription === 'string' && { subscription }),
    payload: decodeEnvelopeData(data),
  };
}

/** Step 1 of the processing flow: message, messageId and a non-empty document must exist. */
export function validateMessage(payload: unknown): InboundMessage {
  if (!isRecord(payload)) {
    throw new ValidationError('Message is required.');
  }

  const { messageId, timestamp, document } = payload;
  if (messageId === undefined || messageId === null) {
    throw new ValidationError('messageId is required.');
  }
  if (typeof messageId !== 'string' || messageId.trim() === '') {
    throw new ValidationError('messageId must be a non-empty string.');
  }
  if (document === undefined || document === null) {
    throw new ValidationError('document is required.');
  }
  if (typeof document !== 'string') {
    throw new ValidationError('document must be a string.');
  }
  if (document.trim() === '') {
    throw new ValidationError('document must not be empty.');
  }

  return {
    messageId,
    ...(typeof timestamp === 'string' && { timestamp }),
    document,
  };
}

/** Best-effort messageId lookup, used to correlate errors raised before validation succeeded. */
export function peekMessageId(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.messageId === 'string' && payload.messageId !== ''
    ? payload.messageId
    : null;
}

function decodeEnvelopeData(data: string): unknown {
  try {
    return JSON.parse(decodeBase64(data).toString('utf8')) as unknown;
  } catch {
    throw new ValidationError('Pub/Sub message data must be a Base64-encoded JSON message.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

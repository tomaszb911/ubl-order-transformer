import type { TransformedOrderMessage } from '../domain/order.js';

export interface OutboundMessage {
  /** Serialised as JSON. */
  data: unknown;
  attributes?: Record<string, string>;
}

/** Publishes messages to a topic. Implemented by Pub/Sub, in-memory and log-only adapters. */
export interface MessagePublisher {
  /** Resolves with the id assigned by the broker. */
  publish(topic: string, message: OutboundMessage): Promise<string>;
  close(): Promise<void>;
}

/** What is remembered about a successfully transformed message. */
export interface IdempotencyRecord {
  output: TransformedOrderMessage;
  /** Fingerprint of the document, to notice a messageId reused for a different order. */
  documentHash: string;
}

/**
 * Remembers successfully transformed messages so that a duplicate delivery of the
 * same business messageId replays the earlier result instead of publishing again.
 */
export interface IdempotencyStore {
  get(messageId: string): Promise<IdempotencyRecord | undefined>;
  save(messageId: string, record: IdempotencyRecord): Promise<void>;
}

/** Tracks delivery attempts and dead-lettered deliveries (keyed by delivery key). */
export interface DeliveryTracker {
  /** Records one more attempt and returns the total number of attempts so far. */
  recordAttempt(deliveryKey: string): Promise<number>;
  /** Marks the delivery as dead-lettered; resolves false when it already was. */
  markDeadLettered(deliveryKey: string): Promise<boolean>;
  isDeadLettered(deliveryKey: string): Promise<boolean>;
}

/** Minimal structured logger contract (satisfied by pino / Fastify's logger). */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

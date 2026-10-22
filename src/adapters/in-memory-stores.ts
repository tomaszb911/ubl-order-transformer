import type { DeliveryTracker, IdempotencyStore } from '../application/ports.js';
import type { TransformedOrderMessage } from '../domain/order.js';
import { TtlCache } from './ttl-cache.js';

export interface InMemoryStoreOptions {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 100_000;

/**
 * Process-local idempotency store.
 *
 * Good enough for a single instance; with several Cloud Run instances the same
 * interface should be backed by a shared store (Firestore / Memorystore) - see README.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly cache: TtlCache<TransformedOrderMessage>;

  constructor({ ttlMs, maxEntries = DEFAULT_MAX_ENTRIES, now }: InMemoryStoreOptions) {
    this.cache = new TtlCache(ttlMs, maxEntries, now);
  }

  get(messageId: string): Promise<TransformedOrderMessage | undefined> {
    return Promise.resolve(this.cache.get(messageId));
  }

  save(messageId: string, output: TransformedOrderMessage): Promise<void> {
    this.cache.set(messageId, output);
    return Promise.resolve();
  }
}

/** Process-local delivery tracker (attempt counters and dead-letter markers). */
export class InMemoryDeliveryTracker implements DeliveryTracker {
  private readonly attempts: TtlCache<number>;
  private readonly deadLettered: TtlCache<true>;

  constructor({ ttlMs, maxEntries = DEFAULT_MAX_ENTRIES, now }: InMemoryStoreOptions) {
    this.attempts = new TtlCache(ttlMs, maxEntries, now);
    this.deadLettered = new TtlCache(ttlMs, maxEntries, now);
  }

  recordAttempt(deliveryKey: string): Promise<number> {
    const attempt = (this.attempts.get(deliveryKey) ?? 0) + 1;
    this.attempts.set(deliveryKey, attempt);
    return Promise.resolve(attempt);
  }

  markDeadLettered(deliveryKey: string): Promise<boolean> {
    const isNew = this.deadLettered.get(deliveryKey) === undefined;
    this.deadLettered.set(deliveryKey, true);
    return Promise.resolve(isNew);
  }

  isDeadLettered(deliveryKey: string): Promise<boolean> {
    return Promise.resolve(this.deadLettered.get(deliveryKey) !== undefined);
  }
}

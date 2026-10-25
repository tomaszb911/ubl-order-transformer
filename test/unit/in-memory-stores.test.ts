import { describe, expect, it } from 'vitest';
import {
  InMemoryDeliveryTracker,
  InMemoryIdempotencyStore,
} from '../../src/adapters/in-memory-stores.js';
import { TtlCache } from '../../src/adapters/ttl-cache.js';
import { EXPECTED_OUTPUT } from '../helpers.js';

describe('TtlCache', () => {
  it('expires entries after the TTL', () => {
    let now = 0;
    const cache = new TtlCache<string>(1000, 10, () => now);
    cache.set('a', 'value');

    now = 999;
    expect(cache.get('a')).toBe('value');
    now = 1000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the oldest entry when full', () => {
    const cache = new TtlCache<number>(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });
});

describe('InMemoryIdempotencyStore', () => {
  it('returns saved records by messageId', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1000 });
    await store.save('m1', { output: EXPECTED_OUTPUT, documentHash: 'abc' });

    expect(await store.get('m1')).toEqual({ output: EXPECTED_OUTPUT, documentHash: 'abc' });
    expect(await store.get('m2')).toBeUndefined();
  });
});

describe('InMemoryDeliveryTracker', () => {
  it('counts attempts per delivery key', async () => {
    const tracker = new InMemoryDeliveryTracker({ ttlMs: 1000 });

    expect(await tracker.recordAttempt('k')).toBe(1);
    expect(await tracker.recordAttempt('k')).toBe(2);
    expect(await tracker.recordAttempt('other')).toBe(1);
  });

  it('remembers dead-lettered deliveries', async () => {
    const tracker = new InMemoryDeliveryTracker({ ttlMs: 1000 });

    expect(await tracker.isDeadLettered('k')).toBe(false);
    expect(await tracker.markDeadLettered('k')).toBe(true);
    expect(await tracker.markDeadLettered('k')).toBe(false);
    expect(await tracker.isDeadLettered('k')).toBe(true);
  });
});

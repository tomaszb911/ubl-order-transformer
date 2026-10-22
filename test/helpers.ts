import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { InMemoryPublisher } from '../src/adapters/in-memory-publisher.js';
import {
  InMemoryDeliveryTracker,
  InMemoryIdempotencyStore,
} from '../src/adapters/in-memory-stores.js';
import { OrderProcessor, type OrderProcessorConfig } from '../src/application/order-processor.js';
import type { TransformedOrderMessage } from '../src/domain/order.js';

export const SAMPLE_XML = readFileSync(
  new URL('./fixtures/ubl-order.xml', import.meta.url),
  'utf8',
);
export const EXPECTED_OUTPUT = JSON.parse(
  readFileSync(new URL('./fixtures/expected-output.json', import.meta.url), 'utf8'),
) as TransformedOrderMessage;

/** Matches `transformedAt` of the expected output fixture. */
export const FIXED_NOW = new Date('2026-07-27T12:01:00.000Z');
export const MESSAGE_ID = '7a1e78c9';

export const silentLogger = pino({ level: 'silent' });

export const toBase64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** Business message as published by the partner. */
export function inboundMessage(
  xml: string = SAMPLE_XML,
  messageId: string = MESSAGE_ID,
): Record<string, unknown> {
  return { messageId, timestamp: '2026-07-27T12:00:00Z', document: toBase64(xml) };
}

/** Pub/Sub push envelope wrapping a business message. */
export function pushEnvelope(
  payload: unknown,
  {
    pubsubMessageId = '1001',
    deliveryAttempt,
  }: { pubsubMessageId?: string; deliveryAttempt?: number } = {},
): Record<string, unknown> {
  return {
    message: {
      data: toBase64(JSON.stringify(payload)),
      messageId: pubsubMessageId,
      publishTime: '2026-07-27T12:00:00Z',
      attributes: {},
    },
    subscription: 'projects/local-project/subscriptions/orders.ubl.received',
    ...(deliveryAttempt !== undefined && { deliveryAttempt }),
  };
}

/** Removes the first occurrence of `fragment` from the sample XML. */
export const sampleWithout = (fragment: string): string => {
  if (!SAMPLE_XML.includes(fragment)) throw new Error(`Fixture does not contain: ${fragment}`);
  return SAMPLE_XML.replace(fragment, '');
};

export const TEST_CONFIG: OrderProcessorConfig = {
  outputTopic: 'orders.transformed',
  deadLetterTopic: 'orders.failed',
  maxDeliveryAttempts: 3,
};

export function createTestProcessor(config: Partial<OrderProcessorConfig> = {}) {
  const publisher = new InMemoryPublisher();
  const deliveryTracker = new InMemoryDeliveryTracker({ ttlMs: 60_000 });
  const idempotencyStore = new InMemoryIdempotencyStore({ ttlMs: 60_000 });
  const processor = new OrderProcessor({
    publisher,
    idempotencyStore,
    deliveryTracker,
    config: { ...TEST_CONFIG, ...config },
    clock: () => FIXED_NOW,
  });
  return { processor, publisher, deliveryTracker, idempotencyStore };
}

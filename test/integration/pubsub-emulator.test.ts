import { randomUUID } from 'node:crypto';
import { PubSub, v1 } from '@google-cloud/pubsub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InMemoryDeliveryTracker,
  InMemoryIdempotencyStore,
} from '../../src/adapters/in-memory-stores.js';
import { PubSubPublisher } from '../../src/adapters/pubsub-publisher.js';
import { OrderProcessor } from '../../src/application/order-processor.js';
import {
  EXPECTED_OUTPUT,
  FIXED_NOW,
  MESSAGE_ID,
  inboundMessage,
  silentLogger,
} from '../helpers.js';

/**
 * Runs against the Pub/Sub emulator (skipped when PUBSUB_EMULATOR_HOST is not set):
 *
 *   docker compose up -d pubsub-emulator
 *   PUBSUB_EMULATOR_HOST=localhost:8085 npm run test:emulator
 */
describe.skipIf(!process.env.PUBSUB_EMULATOR_HOST)('PubSubPublisher (emulator)', () => {
  const projectId = 'local-project';
  const suffix = randomUUID().slice(0, 8);
  const outputTopic = `orders.transformed.test-${suffix}`;
  const deadLetterTopic = `orders.failed.test-${suffix}`;

  let pubsub: PubSub;
  let subscriber: v1.SubscriberClient;
  let processor: OrderProcessor;
  let publisher: PubSubPublisher;

  beforeAll(async () => {
    process.env.METADATA_SERVER_DETECTION ??= 'none';
    pubsub = new PubSub({ projectId });
    for (const topic of [outputTopic, deadLetterTopic]) {
      const [created] = await pubsub.createTopic(topic);
      await created.createSubscription(`${topic}.sub`);
    }
    subscriber = new v1.SubscriberClient({ ...(await pubsub.getClientConfig()) });

    publisher = new PubSubPublisher(new PubSub({ projectId }));
    processor = new OrderProcessor({
      publisher,
      idempotencyStore: new InMemoryIdempotencyStore({ ttlMs: 60_000 }),
      deliveryTracker: new InMemoryDeliveryTracker({ ttlMs: 60_000 }),
      config: { outputTopic, deadLetterTopic, maxDeliveryAttempts: 3 },
      clock: () => FIXED_NOW,
    });
  });

  afterAll(async () => {
    await Promise.all([outputTopic, deadLetterTopic].map((t) => pubsub.topic(t).delete()));
    await publisher.close();
    await subscriber.close();
    await pubsub.close();
  });

  async function pull(topic: string) {
    const subscription = subscriber.subscriptionPath(projectId, `${topic}.sub`);
    const [response] = await subscriber.pull({
      subscription,
      maxMessages: 10,
      returnImmediately: true,
    });
    return (response.receivedMessages ?? []).map(({ message }) => ({
      attributes: message?.attributes,
      data: JSON.parse(Buffer.from(message?.data ?? '').toString('utf8')) as unknown,
    }));
  }

  it('publishes the transformed order to the output topic', async () => {
    const result = await processor.process(inboundMessage(), silentLogger);

    expect(result.outcome).toBe('transformed');
    expect(await pull(outputTopic)).toEqual([
      { attributes: { messageId: MESSAGE_ID, orderId: '12347' }, data: EXPECTED_OUTPUT },
    ]);
  });

  it('publishes a malformed message to the dead-letter topic', async () => {
    const result = await processor.process({ messageId: 'bad', document: '%%%' }, silentLogger);

    expect(result).toMatchObject({ outcome: 'rejected', deadLettered: true });
    expect(await pull(deadLetterTopic)).toEqual([
      expect.objectContaining({
        attributes: { errorCode: 'InvalidBase64', messageId: 'bad' },
        data: expect.objectContaining({ messageId: 'bad' }),
      }),
    ]);
  });
});

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { DeadLetterRecord } from '../../src/application/order-processor.js';
import {
  EXPECTED_OUTPUT,
  MESSAGE_ID,
  SAMPLE_XML,
  createTestProcessor,
  inboundMessage,
  pushEnvelope,
  sampleWithout,
  silentLogger,
  toBase64,
} from '../helpers.js';

const invalidBase64Message = { messageId: 'bad-1', document: '%%%' };

/** Logger that keeps the JSON lines it writes, to assert on what was logged. */
function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    {},
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { lines, logger };
}

describe('OrderProcessor', () => {
  describe('happy path', () => {
    it('transforms the message and publishes it to the output topic', async () => {
      const { processor, publisher } = createTestProcessor();

      const result = await processor.process(inboundMessage(), silentLogger);

      expect(result).toEqual({
        outcome: 'transformed',
        messageId: MESSAGE_ID,
        output: EXPECTED_OUTPUT,
        replayed: false,
      });
      expect(publisher.messagesOn('orders.transformed')).toEqual([
        {
          id: '1',
          topic: 'orders.transformed',
          data: EXPECTED_OUTPUT,
          attributes: { messageId: MESSAGE_ID, orderId: '12347' },
        },
      ]);
    });

    it('processes a Pub/Sub push envelope the same way', async () => {
      const { processor, publisher } = createTestProcessor();

      const result = await processor.process(pushEnvelope(inboundMessage()), silentLogger);

      expect(result).toMatchObject({ outcome: 'transformed', output: EXPECTED_OUTPUT });
      expect(publisher.messagesOn('orders.transformed')).toHaveLength(1);
    });

    it('transforms an Order without the UBL namespace and logs a warning', async () => {
      const { processor, publisher } = createTestProcessor();
      const { lines, logger } = captureLogs();
      const xml = sampleWithout(' xmlns="urn:oasis:names:specification:ubl:schema:xsd:Order-2"');

      const result = await processor.process(inboundMessage(xml), logger);

      expect(result).toMatchObject({ outcome: 'transformed', output: EXPECTED_OUTPUT });
      expect(publisher.messagesOn('orders.transformed')).toHaveLength(1);
      expect(lines).toContainEqual(
        expect.objectContaining({
          messageId: MESSAGE_ID,
          msg: 'UBL document accepted with a warning',
          warning: expect.stringContaining("Root element 'Order' has no namespace"),
        }),
      );
    });
  });

  describe('idempotency', () => {
    it('does not publish a duplicate message twice and replays the earlier output', async () => {
      const { processor, publisher } = createTestProcessor();

      await processor.process(inboundMessage(), silentLogger);
      const second = await processor.process(
        pushEnvelope(inboundMessage(), { pubsubMessageId: 'another-delivery' }),
        silentLogger,
      );

      expect(second).toEqual({
        outcome: 'transformed',
        messageId: MESSAGE_ID,
        output: EXPECTED_OUTPUT,
        replayed: true,
      });
      expect(publisher.messagesOn('orders.transformed')).toHaveLength(1);
    });

    it('publishes once when the same message arrives concurrently', async () => {
      const { processor, publisher } = createTestProcessor();

      const results = await Promise.all(
        [1, 2, 3].map(() => processor.process(inboundMessage(), silentLogger)),
      );

      expect(publisher.messagesOn('orders.transformed')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'transformed' && !r.replayed)).toHaveLength(1);
    });

    it('processes different messageIds independently', async () => {
      const { processor, publisher } = createTestProcessor();

      await processor.process(inboundMessage(undefined, 'a'), silentLogger);
      await processor.process(inboundMessage(undefined, 'b'), silentLogger);

      expect(publisher.messagesOn('orders.transformed')).toHaveLength(2);
    });

    it('flags a replay whose document differs from the original one', async () => {
      const { processor, publisher } = createTestProcessor();
      const otherOrder = SAMPLE_XML.replace('<cbc:ID>12347</cbc:ID>', '<cbc:ID>99999</cbc:ID>');

      await processor.process(inboundMessage(), silentLogger);
      const reused = await processor.process(inboundMessage(otherOrder), silentLogger);

      expect(reused).toEqual({
        outcome: 'transformed',
        messageId: MESSAGE_ID,
        output: EXPECTED_OUTPUT,
        replayed: true,
        documentMismatch: true,
      });
      expect(publisher.messagesOn('orders.transformed')).toHaveLength(1);
    });

    it('does not flag the same document encoded with line breaks', async () => {
      const { processor } = createTestProcessor();
      const wrapped = toBase64(SAMPLE_XML).replace(/(.{76})/g, '$1\r\n');

      await processor.process(inboundMessage(), silentLogger);
      const duplicate = await processor.process(
        { messageId: MESSAGE_ID, document: wrapped },
        silentLogger,
      );

      expect(duplicate).toMatchObject({ outcome: 'transformed', replayed: true });
      expect(duplicate).not.toHaveProperty('documentMismatch');
    });

    it('flags a different document arriving concurrently with the original', async () => {
      const { processor, publisher } = createTestProcessor();
      const otherOrder = SAMPLE_XML.replace('<cbc:ID>12347</cbc:ID>', '<cbc:ID>99999</cbc:ID>');

      const [original, reused] = await Promise.all([
        processor.process(inboundMessage(), silentLogger),
        processor.process(inboundMessage(otherOrder), silentLogger),
      ]);

      expect(original).not.toHaveProperty('documentMismatch');
      expect(reused).toMatchObject({ replayed: true, documentMismatch: true });
      expect(publisher.messagesOn('orders.transformed')).toHaveLength(1);
    });

    it('logs a reused messageId as a warning', async () => {
      const { processor } = createTestProcessor();
      const { lines, logger } = captureLogs();
      const otherOrder = SAMPLE_XML.replace('<cbc:ID>12347</cbc:ID>', '<cbc:ID>99999</cbc:ID>');

      await processor.process(inboundMessage(), logger);
      await processor.process(inboundMessage(otherOrder), logger);

      expect(lines).toContainEqual(
        expect.objectContaining({
          level: 40, // pino "warn"
          messageId: MESSAGE_ID,
          documentMismatch: true,
          msg: 'messageId reused with a different document, earlier result replayed',
        }),
      );
    });

    it('allows a corrected message to be processed after an earlier failure', async () => {
      const { processor, publisher } = createTestProcessor();

      await processor.process({ messageId: MESSAGE_ID, document: '%%%' }, silentLogger);
      const result = await processor.process(inboundMessage(), silentLogger);

      expect(result.outcome).toBe('transformed');
      expect(publisher.messagesOn('orders.transformed')).toHaveLength(1);
    });
  });

  describe('permanent failures', () => {
    it('rejects the message and dead-letters it immediately', async () => {
      const { processor, publisher } = createTestProcessor();

      const result = await processor.process(invalidBase64Message, silentLogger);

      expect(result).toMatchObject({
        outcome: 'rejected',
        messageId: 'bad-1',
        error: { code: 'InvalidBase64', httpStatus: 400 },
        attempt: 1,
        deadLettered: true,
      });
      expect(publisher.messagesOn('orders.transformed')).toHaveLength(0);

      const [deadLetter] = publisher.messagesOn('orders.failed');
      expect(deadLetter?.attributes).toEqual({ errorCode: 'InvalidBase64', messageId: 'bad-1' });
      expect(deadLetter?.data).toEqual({
        messageId: 'bad-1',
        failedAt: '2026-07-27T12:01:00Z',
        error: {
          code: 'InvalidBase64',
          message: 'Document is not a valid Base64 string.',
          detail: 'Base64 length 3 is not a multiple of 4',
        },
        deliveryAttempt: 1,
        source: 'direct',
        originalMessage: invalidBase64Message,
      } satisfies DeadLetterRecord);
    });

    it('dead-letters a message without messageId, keeping the original payload', async () => {
      const { processor, publisher } = createTestProcessor();

      const result = await processor.process({ document: 'abcd' }, silentLogger);

      expect(result).toMatchObject({ outcome: 'rejected', messageId: null, deadLettered: true });
      expect(publisher.messagesOn('orders.failed')[0]?.data).toMatchObject({
        messageId: null,
        error: { code: 'ValidationError', message: 'messageId is required.' },
        originalMessage: { document: 'abcd' },
      });
    });

    it('acknowledges Pub/Sub redeliveries of an already dead-lettered message', async () => {
      const { processor, publisher } = createTestProcessor();
      const envelope = pushEnvelope(invalidBase64Message, { pubsubMessageId: 'ps-1' });

      const first = await processor.process(envelope, silentLogger);
      const redelivery = await processor.process(envelope, silentLogger);

      expect(first).toMatchObject({ outcome: 'rejected', deadLettered: true });
      expect(redelivery).toEqual({ outcome: 'already-dead-lettered', messageId: 'bad-1' });
      expect(publisher.messagesOn('orders.failed')).toHaveLength(1);
    });

    it('keeps answering direct calls with the error, but dead-letters only once', async () => {
      const { processor, publisher } = createTestProcessor();

      const first = await processor.process(invalidBase64Message, silentLogger);
      const second = await processor.process(invalidBase64Message, silentLogger);

      expect(first.outcome).toBe('rejected');
      expect(second.outcome).toBe('rejected');
      expect(publisher.messagesOn('orders.failed')).toHaveLength(1);
    });
  });

  describe('retryable failures', () => {
    it('does not dead-letter before the maximum number of attempts', async () => {
      const { processor, publisher } = createTestProcessor({ maxDeliveryAttempts: 3 });
      publisher.failOn('orders.transformed', new Error('Pub/Sub unavailable'));

      const first = await processor.process(inboundMessage(), silentLogger);
      const second = await processor.process(inboundMessage(), silentLogger);

      expect(first).toMatchObject({
        outcome: 'rejected',
        error: { code: 'ServerError', httpStatus: 500 },
        attempt: 1,
        deadLettered: false,
      });
      expect(second).toMatchObject({ attempt: 2, deadLettered: false });
    });

    it('dead-letters once the maximum number of attempts is reached', async () => {
      const { processor, publisher } = createTestProcessor({ maxDeliveryAttempts: 3 });
      publisher.failOn('orders.transformed', new Error('Pub/Sub unavailable'));

      const envelope = pushEnvelope(inboundMessage(), { pubsubMessageId: 'ps-7' });
      const results = [];
      for (let i = 0; i < 3; i++) {
        results.push(await processor.process(envelope, silentLogger));
      }
      publisher.recover();
      const afterDeadLetter = await processor.process(envelope, silentLogger);

      expect(results.map((r) => r.outcome === 'rejected' && r.deadLettered)).toEqual([
        false,
        false,
        true,
      ]);
      expect(publisher.messagesOn('orders.failed')[0]?.data).toMatchObject({
        messageId: MESSAGE_ID,
        error: {
          code: 'ServerError',
          detail: 'Failed to publish to orders.transformed: Pub/Sub unavailable',
        },
        deliveryAttempt: 3,
        pubsubMessageId: 'ps-7',
      });
      expect(afterDeadLetter.outcome).toBe('already-dead-lettered');
    });

    it('prefers the deliveryAttempt reported by Pub/Sub over its own counter', async () => {
      const { processor, publisher } = createTestProcessor({ maxDeliveryAttempts: 5 });
      publisher.failOn('orders.transformed', new Error('boom'));

      const result = await processor.process(
        pushEnvelope(inboundMessage(), { deliveryAttempt: 5 }),
        silentLogger,
      );

      expect(result).toMatchObject({ outcome: 'rejected', attempt: 5, deadLettered: true });
      expect(publisher.messagesOn('orders.failed')).toHaveLength(1);
    });

    it('answers with a retryable error when dead-lettering itself fails', async () => {
      const { processor, publisher } = createTestProcessor();
      publisher.failOn('orders.failed', new Error('Pub/Sub unavailable'));

      const result = await processor.process(invalidBase64Message, silentLogger);

      expect(result).toMatchObject({
        outcome: 'rejected',
        error: { code: 'ServerError', httpStatus: 500 },
        deadLettered: false,
      });
    });

    it('turns unexpected exceptions into a ServerError', async () => {
      const { processor, idempotencyStore } = createTestProcessor();
      idempotencyStore.get = () => Promise.reject(new TypeError('store exploded'));

      const result = await processor.process(inboundMessage(), silentLogger);

      expect(result).toMatchObject({
        outcome: 'rejected',
        messageId: MESSAGE_ID,
        error: { code: 'ServerError', message: 'An unexpected error occurred.' },
      });
    });
  });
});

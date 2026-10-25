import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InMemoryPublisher } from '../../src/adapters/in-memory-publisher.js';
import { PUSH_ENDPOINT, buildApp } from '../../src/http/app.js';
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

/**
 * Integration tests: the full HTTP stack (Fastify routing, body parsing, error mapping)
 * wired to the real processor and in-memory adapters - only the broker is replaced.
 */
describe(`POST ${PUSH_ENDPOINT}`, () => {
  let app: FastifyInstance;
  let publisher: InMemoryPublisher;

  beforeEach(async () => {
    const testProcessor = createTestProcessor({ maxDeliveryAttempts: 3 });
    publisher = testProcessor.publisher;
    app = buildApp({ processor: testProcessor.processor, logger: silentLogger });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: PUSH_ENDPOINT, payload: payload as object });

  describe('consuming a valid message', () => {
    it('returns the transformed order and publishes it to orders.transformed', async () => {
      const response = await post(pushEnvelope(inboundMessage()));

      expect(response.statusCode).toBe(200);
      expect(response.headers['x-idempotent-replay']).toBe('false');
      expect(response.json()).toEqual(EXPECTED_OUTPUT);

      expect(publisher.messagesOn('orders.transformed')).toEqual([
        expect.objectContaining({
          data: EXPECTED_OUTPUT,
          attributes: { messageId: MESSAGE_ID, orderId: '12347' },
        }),
      ]);
      expect(publisher.messagesOn('orders.failed')).toEqual([]);
    });

    it('accepts the business message posted directly (local testing)', async () => {
      const response = await post(inboundMessage());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(EXPECTED_OUTPUT);
    });

    it('accepts an Order without the UBL namespace (logged as a warning)', async () => {
      const xml = sampleWithout(' xmlns="urn:oasis:names:specification:ubl:schema:xsd:Order-2"');

      const response = await post(inboundMessage(xml));

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(EXPECTED_OUTPUT);
    });

    it('accepts JSON sent with a non-JSON content type', async () => {
      const response = await app.inject({
        method: 'POST',
        url: PUSH_ENDPOINT,
        headers: { 'content-type': 'text/plain' },
        payload: JSON.stringify(inboundMessage()),
      });

      expect(response.statusCode).toBe(200);
    });

    it('publishes a duplicate message only once', async () => {
      const first = await post(pushEnvelope(inboundMessage(), { pubsubMessageId: '1' }));
      const duplicate = await post(pushEnvelope(inboundMessage(), { pubsubMessageId: '2' }));

      expect(first.statusCode).toBe(200);
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.headers['x-idempotent-replay']).toBe('true');
      expect(duplicate.json()).toEqual(first.json());
      expect(publisher.messagesOn('orders.transformed')).toHaveLength(1);
    });
    it('flags a messageId reused for a different document with a response header', async () => {
      const otherOrder = SAMPLE_XML.replace('<cbc:ID>12347</cbc:ID>', '<cbc:ID>99999</cbc:ID>');

      const first = await post(inboundMessage());
      const reused = await post(inboundMessage(otherOrder));

      expect(first.headers).not.toHaveProperty('x-document-mismatch');
      expect(reused.statusCode).toBe(200);
      expect(reused.headers['x-idempotent-replay']).toBe('true');
      expect(reused.headers['x-document-mismatch']).toBe('true');
      expect(reused.json()).toEqual(EXPECTED_OUTPUT);
      expect(publisher.messagesOn('orders.transformed')).toHaveLength(1);
    });
  });

  describe('consuming a malformed message', () => {
    it.each([
      [
        'invalid Base64 document',
        { messageId: MESSAGE_ID, document: 'not*base64!' },
        {
          error: 'InvalidBase64',
          message: 'Document is not a valid Base64 string.',
          messageId: MESSAGE_ID,
        },
      ],
      [
        'document that is not XML',
        { messageId: MESSAGE_ID, document: toBase64('{"json": "instead of xml"}') },
        {
          error: 'InvalidXml',
          message: 'Message could not be parsed from XML to JSON.',
          messageId: MESSAGE_ID,
        },
      ],
      [
        'truncated XML',
        inboundMessage('<Order><cbc:ID>1</cbc:ID>'),
        {
          error: 'InvalidXml',
          message: 'Message could not be parsed from XML to JSON.',
          messageId: MESSAGE_ID,
        },
      ],
      [
        'order without ID',
        inboundMessage(sampleWithout('<cbc:ID>12347</cbc:ID>')),
        { error: 'ValidationError', message: 'Order ID is required.', messageId: MESSAGE_ID },
      ],
      [
        'XML that is not a UBL Order',
        inboundMessage('<Invoice><ID>1</ID></Invoice>'),
        {
          error: 'ValidationError',
          message: "Document is not a UBL Order (expected root element 'Order', found 'Invoice').",
          messageId: MESSAGE_ID,
        },
      ],
      [
        'Order outside the UBL namespace',
        inboundMessage('<Order xmlns="urn:example:order"><ID>1</ID></Order>'),
        {
          error: 'ValidationError',
          message:
            "Document is not a UBL Order (expected namespace 'urn:oasis:names:specification:ubl:schema:xsd:Order-2', found 'urn:example:order').",
          messageId: MESSAGE_ID,
        },
      ],
      [
        'message without messageId',
        { document: toBase64('<Order/>') },
        { error: 'ValidationError', message: 'messageId is required.', messageId: null },
      ],
      [
        'message without document',
        { messageId: MESSAGE_ID },
        { error: 'ValidationError', message: 'document is required.', messageId: MESSAGE_ID },
      ],
      [
        'message with an empty document',
        { messageId: MESSAGE_ID, document: '' },
        { error: 'ValidationError', message: 'document must not be empty.', messageId: MESSAGE_ID },
      ],
    ])('returns 400 for %s (push envelope)', async (_case, payload, expected) => {
      const response = await post(pushEnvelope(payload));

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(expected);
      expect(publisher.messagesOn('orders.transformed')).toEqual([]);
    });

    it('returns the same errors for direct calls', async () => {
      const response = await post({ messageId: MESSAGE_ID, document: 'not*base64!' });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'InvalidBase64',
        message: 'Document is not a valid Base64 string.',
        messageId: MESSAGE_ID,
      });
    });

    it('returns 400 for a request without body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: PUSH_ENDPOINT,
        headers: { 'content-type': 'application/json' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'ValidationError',
        message: 'Message is required.',
        messageId: null,
      });
    });

    it('returns 400 for a body that is not JSON', async () => {
      const response = await app.inject({
        method: 'POST',
        url: PUSH_ENDPOINT,
        headers: { 'content-type': 'application/json' },
        payload: '{"messageId": ',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'ValidationError', messageId: null });
    });

    it('returns 400 for a push envelope whose data is not JSON', async () => {
      const response = await post({ message: { data: toBase64('<Order/>'), messageId: '1' } });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'ValidationError',
        message: 'Pub/Sub message data must be a Base64-encoded JSON message.',
        messageId: null,
      });
    });
  });

  describe('dead-letter queue and retries', () => {
    it('publishes a malformed message to orders.failed with the failure reason', async () => {
      await post(
        pushEnvelope({ messageId: MESSAGE_ID, document: 'not*base64!' }, { pubsubMessageId: '42' }),
      );

      const deadLetters = publisher.messagesOn('orders.failed');
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]).toMatchObject({
        attributes: { errorCode: 'InvalidBase64', messageId: MESSAGE_ID },
        data: {
          messageId: MESSAGE_ID,
          error: { code: 'InvalidBase64' },
          source: 'pubsub-push',
          pubsubMessageId: '42',
          originalMessage: { messageId: MESSAGE_ID, document: 'not*base64!' },
        },
      });
    });

    it('acknowledges (204) Pub/Sub redeliveries of a dead-lettered message', async () => {
      const envelope = pushEnvelope(
        { messageId: MESSAGE_ID, document: 'not*base64!' },
        { pubsubMessageId: '42' },
      );

      const first = await post(envelope);
      const redelivery = await post(envelope);

      expect(first.statusCode).toBe(400);
      expect(redelivery.statusCode).toBe(204);
      expect(publisher.messagesOn('orders.failed')).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('returns 500 when publishing fails, so that Pub/Sub retries', async () => {
      publisher.failOn('orders.transformed', new Error('Pub/Sub unavailable'));

      const response = await post(pushEnvelope(inboundMessage()));

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: 'ServerError',
        message: 'An unexpected error occurred.',
        messageId: MESSAGE_ID,
      });
      expect(publisher.messagesOn('orders.failed')).toEqual([]);
    });

    it('succeeds on a retry once publishing recovers', async () => {
      publisher.failOn('orders.transformed', new Error('Pub/Sub unavailable'));
      const envelope = pushEnvelope(inboundMessage(), { pubsubMessageId: '77' });

      const failed = await post(envelope);
      publisher.recover();
      const retried = await post(envelope);

      expect(failed.statusCode).toBe(500);
      expect(retried.statusCode).toBe(200);
      expect(publisher.messagesOn('orders.transformed')).toHaveLength(1);
    });

    it('dead-letters after the configured number of failed attempts', async () => {
      publisher.failOn('orders.transformed', new Error('Pub/Sub unavailable'));
      const envelope = pushEnvelope(inboundMessage(), { pubsubMessageId: '77' });

      const statuses = [];
      for (let attempt = 1; attempt <= 4; attempt++) {
        statuses.push((await post(envelope)).statusCode);
      }

      expect(statuses).toEqual([500, 500, 500, 204]);
      expect(publisher.messagesOn('orders.failed')).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            deliveryAttempt: 3,
            error: expect.objectContaining({ code: 'ServerError' }),
          }),
        }),
      ]);
    });

    it('does not leak internal error details to the caller', async () => {
      publisher.failOn('orders.transformed', new Error('secret connection string'));

      const response = await post(inboundMessage());

      expect(response.body).not.toContain('secret');
    });
  });
});

describe('request size limit', () => {
  it('rejects messages above the configured body limit', async () => {
    const app = buildApp({
      processor: createTestProcessor().processor,
      logger: silentLogger,
      bodyLimitBytes: 1024,
    });

    const response = await app.inject({
      method: 'POST',
      url: PUSH_ENDPOINT,
      payload: inboundMessage(),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: 'ValidationError',
      message: 'Message exceeds the maximum allowed size.',
      messageId: null,
    });
    await app.close();
  });
});

describe('unknown routes', () => {
  it('returns 404', async () => {
    const app = buildApp({ processor: createTestProcessor().processor, logger: silentLogger });

    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /healthz', () => {
  it('reports the service as healthy', async () => {
    const app = buildApp({ processor: createTestProcessor().processor, logger: silentLogger });

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});

import { describe, expect, it } from 'vitest';
import {
  parseDelivery,
  peekMessageId,
  validateMessage,
} from '../../src/application/inbound-message.js';
import { ValidationError } from '../../src/domain/errors.js';
import { inboundMessage, pushEnvelope, toBase64 } from '../helpers.js';

describe('validateMessage', () => {
  it('accepts a complete message', () => {
    const message = inboundMessage();
    expect(validateMessage(message)).toEqual(message);
  });

  it('accepts a message without timestamp', () => {
    expect(validateMessage({ messageId: 'a', document: 'abcd' })).toEqual({
      messageId: 'a',
      document: 'abcd',
    });
  });

  it.each([
    ['missing message (undefined)', undefined, 'Message is required.'],
    ['missing message (null)', null, 'Message is required.'],
    ['message that is not an object', 'hello', 'Message is required.'],
    ['message that is an array', [], 'Message is required.'],
    ['missing messageId', { document: 'abcd' }, 'messageId is required.'],
    [
      'blank messageId',
      { messageId: '  ', document: 'abcd' },
      'messageId must be a non-empty string.',
    ],
    [
      'numeric messageId',
      { messageId: 1, document: 'abcd' },
      'messageId must be a non-empty string.',
    ],
    ['missing document', { messageId: 'a' }, 'document is required.'],
    ['null document', { messageId: 'a', document: null }, 'document is required.'],
    ['non-string document', { messageId: 'a', document: 42 }, 'document must be a string.'],
    ['empty document', { messageId: 'a', document: '' }, 'document must not be empty.'],
    ['blank document', { messageId: 'a', document: '   ' }, 'document must not be empty.'],
  ])('rejects %s', (_case, payload, message) => {
    expect(() => validateMessage(payload)).toThrow(new ValidationError(message));
  });
});

describe('parseDelivery', () => {
  it('treats a body without "message" as a direct delivery', () => {
    const body = inboundMessage();
    expect(parseDelivery(body)).toEqual({ source: 'direct', payload: body });
  });

  it('unwraps a Pub/Sub push envelope', () => {
    const payload = inboundMessage();
    expect(
      parseDelivery(pushEnvelope(payload, { pubsubMessageId: '555', deliveryAttempt: 2 })),
    ).toEqual({
      source: 'pubsub-push',
      pubsubMessageId: '555',
      deliveryAttempt: 2,
      subscription: 'projects/local-project/subscriptions/orders.ubl.received',
      payload,
    });
  });

  it('rejects a missing body', () => {
    expect(() => parseDelivery(undefined)).toThrow(new ValidationError('Message is required.'));
  });

  it('rejects an envelope without data', () => {
    expect(() => parseDelivery({ message: { messageId: '1' } })).toThrow(
      new ValidationError('Message is required.'),
    );
  });

  it('rejects envelope data that is not Base64-encoded JSON', () => {
    expect(() => parseDelivery({ message: { data: toBase64('not json') } })).toThrow(
      /must be a Base64-encoded JSON message/,
    );
    expect(() => parseDelivery({ message: { data: '%%%' } })).toThrow(
      /must be a Base64-encoded JSON message/,
    );
  });
});

describe('peekMessageId', () => {
  it('returns the messageId when present', () => {
    expect(peekMessageId({ messageId: 'abc' })).toBe('abc');
  });

  it.each([undefined, null, 'x', {}, { messageId: 7 }, { messageId: '' }])(
    'returns null for %j',
    (payload) => {
      expect(peekMessageId(payload)).toBeNull();
    },
  );
});

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('uses sensible defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 8080,
      logLevel: 'info',
      logPretty: false,
      serviceName: 'ubl-order-transformer',
      publisher: 'pubsub',
      outputTopic: 'orders.transformed',
      deadLetterTopic: 'orders.failed',
      maxDeliveryAttempts: 5,
      idempotencyTtlSeconds: 86_400,
      bodyLimitBytes: 15 * 1024 * 1024,
    });
  });

  it('reads values from the environment', () => {
    const config = loadConfig({
      PORT: '3000',
      PUBLISHER: 'log',
      OUTPUT_TOPIC: 'out',
      DEAD_LETTER_TOPIC: 'dlq',
      MAX_DELIVERY_ATTEMPTS: '10',
      K_SERVICE: 'order-transformer',
    });

    expect(config).toMatchObject({
      port: 3000,
      publisher: 'log',
      outputTopic: 'out',
      deadLetterTopic: 'dlq',
      maxDeliveryAttempts: 10,
      serviceName: 'order-transformer',
    });
  });

  it('fails fast listing every invalid value', () => {
    expect(() =>
      loadConfig({ PORT: 'abc', PUBLISHER: 'kafka', MAX_DELIVERY_ATTEMPTS: '0' }),
    ).toThrow(
      /PORT must be an integer >= 1[\s\S]*PUBLISHER must be one of pubsub, log[\s\S]*MAX_DELIVERY_ATTEMPTS must be an integer >= 1/,
    );
  });
});

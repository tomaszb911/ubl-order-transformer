import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUSH_ENDPOINT, buildApp } from '../../src/http/app.js';
import { EXPECTED_OUTPUT, createTestProcessor, silentLogger } from '../helpers.js';

/** Keeps the sample messages referenced in the README honest. */
describe('sample messages', () => {
  const sample = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(`../../samples/messages/${name}`, import.meta.url), 'utf8'));

  it.each([
    ['valid-order.json', 200, EXPECTED_OUTPUT],
    ['pubsub-push-envelope.json', 200, EXPECTED_OUTPUT],
    ['valid-order-single-line.json', 200, expect.objectContaining({ messageId: 'b5c2d4e1' })],
    ['invalid-base64.json', 400, expect.objectContaining({ error: 'InvalidBase64' })],
    ['invalid-xml.json', 400, expect.objectContaining({ error: 'InvalidXml' })],
    [
      'missing-order-id.json',
      400,
      { error: 'ValidationError', message: 'Order ID is required.', messageId: 'c0ffee03' },
    ],
    ['missing-document.json', 400, expect.objectContaining({ message: 'document is required.' })],
  ])('%s -> %i', async (file, status, body) => {
    const app = buildApp({ processor: createTestProcessor().processor, logger: silentLogger });

    const response = await app.inject({
      method: 'POST',
      url: PUSH_ENDPOINT,
      payload: sample(file) as object,
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual(body);
    await app.close();
  });

  it('documents the expected output next to the samples', () => {
    expect(sample('../output/transformed-order.json')).toEqual(EXPECTED_OUTPUT);
  });
});

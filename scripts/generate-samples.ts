/**
 * Regenerates samples/messages from samples/ubl, so the Base64 payloads always
 * match the readable XML next to them.
 *
 *   npm run samples:generate
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { xmlToMessage } from './lib/message-file.js';

const TIMESTAMP = '2026-07-27T12:00:00Z';
const xml = (name: string) => readFileSync(`samples/ubl/${name}`, 'utf8');
const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const message = (messageId: string, document: string) => ({
  messageId,
  timestamp: TIMESTAMP,
  document,
});

const validOrder = { ...xmlToMessage(xml('order.xml'), '7a1e78c9'), timestamp: TIMESTAMP };

const samples: Record<string, unknown> = {
  'valid-order.json': validOrder,
  'valid-order-single-line.json': message('b5c2d4e1', base64(xml('order-single-line.xml'))),
  'invalid-base64.json': message('c0ffee01', 'this is *not* Base64!'),
  'invalid-xml.json': message('c0ffee02', base64('<Order><cbc:ID>12347</cbc:ID>')),
  'missing-order-id.json': message('c0ffee03', base64(xml('order-missing-id.xml'))),
  'missing-document.json': { messageId: 'c0ffee04', timestamp: TIMESTAMP },
  // What Cloud Run actually receives from a Pub/Sub push subscription.
  'pubsub-push-envelope.json': {
    message: {
      data: base64(JSON.stringify(validOrder)),
      messageId: '15386731280394612',
      publishTime: TIMESTAMP,
      attributes: {},
    },
    subscription: 'projects/local-project/subscriptions/orders.ubl.received',
  },
};

for (const [file, content] of Object.entries(samples)) {
  writeFileSync(`samples/messages/${file}`, `${JSON.stringify(content, null, 2)}\n`);
  console.log(`samples/messages/${file}`);
}

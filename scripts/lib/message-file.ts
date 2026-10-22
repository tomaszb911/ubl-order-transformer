import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * Reads a test message: a `.json` file is used as-is (business message format),
 * a `.xml` file is wrapped into a new message with a generated messageId.
 */
export function readMessageFile(path: string, messageId?: string): Record<string, unknown> {
  const content = readFileSync(path, 'utf8');
  if (extname(path).toLowerCase() === '.xml') {
    return xmlToMessage(content, messageId);
  }
  const message = JSON.parse(content) as Record<string, unknown>;
  return messageId === undefined ? message : { ...message, messageId };
}

export function xmlToMessage(
  xml: string,
  messageId: string = randomUUID(),
): Record<string, unknown> {
  return {
    messageId,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    document: Buffer.from(xml, 'utf8').toString('base64'),
  };
}

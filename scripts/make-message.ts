/**
 * Wraps a UBL XML file into a business message (Base64 document) and prints it.
 *
 *   npm run make:message -- samples/ubl/order.xml 7a1e78c9 > message.json
 */
import { readFileSync } from 'node:fs';
import { xmlToMessage } from './lib/message-file.js';

const [file, messageId] = process.argv.slice(2);
if (file === undefined) {
  console.error('Usage: make-message <order.xml> [messageId]');
  process.exit(2);
}
console.log(JSON.stringify(xmlToMessage(readFileSync(file, 'utf8'), messageId), null, 2));

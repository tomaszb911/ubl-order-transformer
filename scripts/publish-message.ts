/**
 * Publishes test messages to the input topic, like the partner system would.
 *
 *   npm run pubsub:publish -- samples/messages/valid-order.json
 *   npm run pubsub:publish -- samples/ubl/order.xml          # wraps XML into a new message
 */
import { TOPICS, createPubSub } from './lib/pubsub-env.js';
import { readMessageFile } from './lib/message-file.js';

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: publish-message <message.json | order.xml> [...more files]');
    process.exit(2);
  }

  const pubsub = createPubSub();
  const topic = pubsub.topic(TOPICS.input);
  for (const file of files) {
    const message = readMessageFile(file);
    const id = await topic.publishMessage({ json: message });
    console.log(
      `Published ${file} (messageId=${String(message.messageId)}) as Pub/Sub message ${id}`,
    );
  }
  await pubsub.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

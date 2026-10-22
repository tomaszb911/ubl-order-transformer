/**
 * Prints (and acknowledges) what the service published to orders.transformed
 * and orders.failed, using the debug pull subscriptions created by pubsub-setup.
 *
 *   npm run pubsub:pull
 */
import { v1 } from '@google-cloud/pubsub';
import { DEBUG_SUBSCRIPTIONS, createPubSub } from './lib/pubsub-env.js';

async function drain(client: v1.SubscriberClient, projectId: string, name: string): Promise<void> {
  const subscription = client.subscriptionPath(projectId, name);
  // Synchronous pull returns what is already there instead of waiting for a stream to settle.
  const [response] = await client.pull({ subscription, maxMessages: 100, returnImmediately: true });
  const received = response.receivedMessages ?? [];

  console.log(`\n=== ${name}: ${received.length} message(s)`);
  for (const { message } of received) {
    const data = Buffer.from(message?.data ?? '').toString('utf8');
    console.log(
      JSON.stringify(
        { attributes: message?.attributes, data: JSON.parse(data) as unknown },
        null,
        2,
      ),
    );
  }

  const ackIds = received.flatMap(({ ackId }) => (ackId ? [ackId] : []));
  if (ackIds.length > 0) {
    await client.acknowledge({ subscription, ackIds });
  }
}

async function main(): Promise<void> {
  const pubsub = createPubSub();
  // Reuses the connection settings (incl. emulator host) resolved by the PubSub client.
  const client = new v1.SubscriberClient({ ...(await pubsub.getClientConfig()) });

  await drain(client, pubsub.projectId, DEBUG_SUBSCRIPTIONS.output);
  await drain(client, pubsub.projectId, DEBUG_SUBSCRIPTIONS.deadLetter);

  await client.close();
  await pubsub.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

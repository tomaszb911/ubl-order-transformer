/**
 * Creates the topics and subscriptions used by the service (idempotent).
 * Intended for the local emulator; in Google Cloud they are managed by Terraform.
 *
 *   PUSH_ENDPOINT=http://localhost:8080/pubsub/push npm run pubsub:setup
 */
import type { PubSub, Topic } from '@google-cloud/pubsub';
import {
  DEBUG_SUBSCRIPTIONS,
  INPUT_SUBSCRIPTION,
  TOPICS,
  createPubSub,
  isAlreadyExists,
} from './lib/pubsub-env.js';

const pushEndpoint = process.env.PUSH_ENDPOINT ?? 'http://localhost:8080/pubsub/push';

async function ensureTopic(pubsub: PubSub, name: string): Promise<Topic> {
  try {
    await pubsub.createTopic(name);
    console.error(`Created topic ${name}`);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    console.error(`Topic ${name} already exists`);
  }
  return pubsub.topic(name);
}

async function ensureSubscription(
  topic: Topic,
  name: string,
  options: Parameters<Topic['createSubscription']>[1] = {},
): Promise<void> {
  try {
    await topic.createSubscription(name, options);
    console.error(`Created subscription ${name} on ${topic.name.split('/').pop()}`);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    console.error(`Subscription ${name} already exists`);
  }
}

async function main(): Promise<void> {
  const pubsub = createPubSub();

  const input = await ensureTopic(pubsub, TOPICS.input);
  const output = await ensureTopic(pubsub, TOPICS.output);
  const deadLetter = await ensureTopic(pubsub, TOPICS.deadLetter);

  await ensureSubscription(input, INPUT_SUBSCRIPTION, {
    pushConfig: { pushEndpoint },
    ackDeadlineSeconds: 30,
  });
  await ensureSubscription(output, DEBUG_SUBSCRIPTIONS.output);
  await ensureSubscription(deadLetter, DEBUG_SUBSCRIPTIONS.deadLetter);

  console.error(`Push subscription ${INPUT_SUBSCRIPTION} delivers to ${pushEndpoint}`);
  await pubsub.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

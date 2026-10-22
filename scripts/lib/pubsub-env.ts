import { PubSub } from '@google-cloud/pubsub';

export const LOCAL_PROJECT_ID = 'local-project';
export const LOCAL_EMULATOR_HOST = 'localhost:8085';

export const TOPICS = {
  input: process.env.INPUT_TOPIC ?? 'orders.ubl.received',
  output: process.env.OUTPUT_TOPIC ?? 'orders.transformed',
  deadLetter: process.env.DEAD_LETTER_TOPIC ?? 'orders.failed',
};

/** The assignment names the input subscription `orders.ubl.received` (same as the topic). */
export const INPUT_SUBSCRIPTION = process.env.INPUT_SUBSCRIPTION ?? TOPICS.input;

/** Pull subscriptions that let developers inspect what the service published. */
export const DEBUG_SUBSCRIPTIONS = {
  output: `${TOPICS.output}.debug`,
  deadLetter: `${TOPICS.deadLetter}.debug`,
};

/**
 * Pub/Sub client for the developer scripts.
 * Without GOOGLE_CLOUD_PROJECT the scripts target the local emulator, so they can
 * never publish to a real project by accident.
 */
export function createPubSub(): PubSub {
  if (process.env.GOOGLE_CLOUD_PROJECT === undefined) {
    process.env.GOOGLE_CLOUD_PROJECT = LOCAL_PROJECT_ID;
    process.env.PUBSUB_EMULATOR_HOST ??= LOCAL_EMULATOR_HOST;
  }
  if (process.env.PUBSUB_EMULATOR_HOST) {
    // No GCE metadata server locally: skip the lookup (otherwise ~3 s timeout + warning).
    process.env.METADATA_SERVER_DETECTION ??= 'none';
  }
  const target = process.env.PUBSUB_EMULATOR_HOST
    ? `emulator at ${process.env.PUBSUB_EMULATOR_HOST}`
    : 'Google Cloud';
  console.error(`Using Pub/Sub ${target}, project ${process.env.GOOGLE_CLOUD_PROJECT}`);
  return new PubSub({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
}

/** gRPC status code returned when a resource already exists. */
export const ALREADY_EXISTS = 6;

export function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === ALREADY_EXISTS
  );
}

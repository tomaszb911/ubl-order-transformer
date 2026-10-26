/**
 * Re-publishes dead-lettered messages to the input topic, e.g. after an outage or a fix.
 *
 *   npm run pubsub:replay -- --dry-run                     # show what would be replayed
 *   npm run pubsub:replay -- --error-code ServerError      # replay transient failures only
 *   npm run pubsub:replay -- --message-id 7a1e78c9
 *
 * Options: --subscription <name> (default orders.failed.debug; on GCP orders.failed.inspection),
 *          --limit <n> (default 100), --dry-run, --message-id <id>, --error-code <code>.
 *
 * Replayed records are acknowledged; skipped ones are released and stay in the subscription.
 * A message that still fails (e.g. invalid XML) simply ends up in the dead-letter topic again.
 */
import { parseArgs } from 'node:util';
import { v1 } from '@google-cloud/pubsub';
import { DEBUG_SUBSCRIPTIONS, TOPICS, createPubSub } from './lib/pubsub-env.js';
import { planReplay } from './lib/replay.js';

const { values: args } = parseArgs({
  options: {
    subscription: { type: 'string', default: DEBUG_SUBSCRIPTIONS.deadLetter },
    limit: { type: 'string', default: '100' },
    'dry-run': { type: 'boolean', default: false },
    'message-id': { type: 'string' },
    'error-code': { type: 'string' },
  },
});

async function main(): Promise<void> {
  const limit = Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer (got '${args.limit}')`);
  }

  const pubsub = createPubSub();
  const client = new v1.SubscriberClient({ ...(await pubsub.getClientConfig()) });
  const subscription = client.subscriptionPath(pubsub.projectId, args.subscription);

  const [response] = await client.pull({
    subscription,
    maxMessages: limit,
    returnImmediately: true,
  });
  const pulled = (response.receivedMessages ?? []).flatMap(({ ackId, message }) =>
    ackId ? [{ ackId, data: Buffer.from(message?.data ?? '').toString('utf8') }] : [],
  );

  const plan = planReplay(pulled, {
    ...(args['message-id'] !== undefined && { messageId: args['message-id'] }),
    ...(args['error-code'] !== undefined && { errorCode: args['error-code'] }),
  });

  console.log(`Pulled ${pulled.length} dead-lettered message(s) from ${args.subscription}`);
  for (const { record } of plan.replay) {
    // Records come from the topic as JSON, so do not trust their shape when printing.
    console.log(
      `  replay  ${String(record.messageId)}  (${record.error?.code ?? 'unknown error'})`,
    );
  }
  for (const { messageId, reason } of plan.skip) {
    console.log(`  skip    ${String(messageId)}  (${reason})`);
  }

  const release = async (ackIds: string[]) => {
    // Deadline 0 hands the messages back immediately instead of after the ack deadline.
    if (ackIds.length > 0) {
      await client.modifyAckDeadline({ subscription, ackIds, ackDeadlineSeconds: 0 });
    }
  };

  let failed = 0;
  if (args['dry-run']) {
    await release(pulled.map(({ ackId }) => ackId));
    console.log('Dry run: nothing was published, all messages stay in the subscription.');
  } else {
    const topic = pubsub.topic(TOPICS.input);
    const replayed: string[] = [];
    const notReplayed: string[] = plan.skip.map(({ ackId }) => ackId);

    for (const { ackId, record, message } of plan.replay) {
      try {
        const id = await topic.publishMessage({
          json: message,
          attributes: {
            replayedFrom: args.subscription,
            ...(record.pubsubMessageId !== undefined && {
              originalPubsubMessageId: record.pubsubMessageId,
            }),
          },
        });
        console.log(`Replayed ${String(record.messageId)} as Pub/Sub message ${id}`);
        replayed.push(ackId);
      } catch (error) {
        console.error(`Failed to replay ${String(record.messageId)}:`, error);
        notReplayed.push(ackId);
        failed++;
      }
    }

    if (replayed.length > 0) {
      await client.acknowledge({ subscription, ackIds: replayed });
    }
    await release(notReplayed);
    console.log(`Replayed ${replayed.length}, left in the subscription ${notReplayed.length}.`);
  }

  await client.close();
  await pubsub.close();
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

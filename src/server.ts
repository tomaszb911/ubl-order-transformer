import { PubSub } from '@google-cloud/pubsub';
import { InMemoryDeliveryTracker, InMemoryIdempotencyStore } from './adapters/in-memory-stores.js';
import { LogPublisher } from './adapters/log-publisher.js';
import { PubSubPublisher } from './adapters/pubsub-publisher.js';
import { OrderProcessor } from './application/order-processor.js';
import type { MessagePublisher } from './application/ports.js';
import { loadConfig } from './config.js';
import { buildApp } from './http/app.js';
import { createLogger } from './logger.js';
import { createShutdownHandler } from './shutdown.js';

/** Composition root: wires configuration, adapters and the HTTP server together. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    pretty: config.logPretty,
    serviceName: config.serviceName,
  });

  const publisher: MessagePublisher =
    config.publisher === 'pubsub' ? new PubSubPublisher(new PubSub()) : new LogPublisher(logger);

  const storeOptions = { ttlMs: config.idempotencyTtlSeconds * 1000 };
  const processor = new OrderProcessor({
    publisher,
    idempotencyStore: new InMemoryIdempotencyStore(storeOptions),
    deliveryTracker: new InMemoryDeliveryTracker(storeOptions),
    config: {
      outputTopic: config.outputTopic,
      deadLetterTopic: config.deadLetterTopic,
      maxDeliveryAttempts: config.maxDeliveryAttempts,
    },
  });

  const app = buildApp({
    processor,
    logger,
    bodyLimitBytes: config.bodyLimitBytes,
    onClose: () => publisher.close(),
  });

  // Cloud Run sends SIGTERM and allows ~10 s to finish in-flight requests.
  const shutdown = createShutdownHandler({
    close: () => app.close(),
    logger,
    timeoutMs: config.shutdownTimeoutMs,
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => shutdown(signal));
  }

  await app.listen({ host: '0.0.0.0', port: config.port });
  logger.info(
    {
      publisher: config.publisher,
      outputTopic: config.outputTopic,
      deadLetterTopic: config.deadLetterTopic,
      maxDeliveryAttempts: config.maxDeliveryAttempts,
    },
    'Service started',
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

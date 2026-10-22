import { randomUUID } from 'node:crypto';
import type { Logger, MessagePublisher, OutboundMessage } from '../application/ports.js';

/**
 * "Mocked" publisher: writes the message to the log instead of a broker.
 * Lets the service run with plain `docker run`, without any Pub/Sub access.
 */
export class LogPublisher implements MessagePublisher {
  constructor(private readonly log: Logger) {}

  publish(topic: string, message: OutboundMessage): Promise<string> {
    const id = randomUUID();
    this.log.info(
      { topic, publishedId: id, attributes: message.attributes, data: message.data },
      `Message published to ${topic} (log publisher)`,
    );
    return Promise.resolve(id);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

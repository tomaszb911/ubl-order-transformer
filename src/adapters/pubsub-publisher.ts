import type { PubSub, Topic } from '@google-cloud/pubsub';
import type { MessagePublisher, OutboundMessage } from '../application/ports.js';

/**
 * Google Cloud Pub/Sub publisher.
 * Honours PUBSUB_EMULATOR_HOST, so the same code runs against the local emulator.
 */
export class PubSubPublisher implements MessagePublisher {
  private readonly topics = new Map<string, Topic>();

  constructor(private readonly pubsub: PubSub) {}

  publish(topicName: string, message: OutboundMessage): Promise<string> {
    return this.topic(topicName).publishMessage({
      json: message.data,
      ...(message.attributes !== undefined && { attributes: message.attributes }),
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.topics.values()].map((topic) => topic.flush()));
    await this.pubsub.close();
  }

  private topic(name: string): Topic {
    let topic = this.topics.get(name);
    if (topic === undefined) {
      topic = this.pubsub.topic(name);
      this.topics.set(name, topic);
    }
    return topic;
  }
}

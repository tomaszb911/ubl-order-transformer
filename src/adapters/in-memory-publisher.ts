import type { MessagePublisher, OutboundMessage } from '../application/ports.js';

export interface PublishedMessage extends OutboundMessage {
  id: string;
  topic: string;
}

/** Keeps published messages in memory. Used by tests and handy for local experiments. */
export class InMemoryPublisher implements MessagePublisher {
  readonly published: PublishedMessage[] = [];
  private sequence = 0;
  private readonly failures = new Map<string, Error>();

  /** Failure injection for tests: publishing to `topic` ('*' = any topic) rejects with `error`. */
  failOn(topic: string, error: Error): void {
    this.failures.set(topic, error);
  }

  recover(): void {
    this.failures.clear();
  }

  publish(topic: string, message: OutboundMessage): Promise<string> {
    const failure = this.failures.get(topic) ?? this.failures.get('*');
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    const id = String(++this.sequence);
    this.published.push({ id, topic, ...message });
    return Promise.resolve(id);
  }

  messagesOn(topic: string): PublishedMessage[] {
    return this.published.filter((message) => message.topic === topic);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

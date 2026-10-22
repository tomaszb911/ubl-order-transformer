import { describe, expect, it } from 'vitest';
import { LogPublisher } from '../../src/adapters/log-publisher.js';
import { createLogger } from '../../src/logger.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = {
    write: (line: string) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  return { lines, destination };
}

describe('createLogger', () => {
  it('writes JSON in the Cloud Logging structured format', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ level: 'info', serviceName: 'svc', destination });

    logger.child({ messageId: 'm-1' }).warn({ durationMs: 12.5 }, 'Message rejected');

    expect(lines).toEqual([
      {
        severity: 'WARNING',
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        service: 'svc',
        messageId: 'm-1',
        durationMs: 12.5,
        message: 'Message rejected',
      },
    ]);
  });

  it.each([
    ['debug', 'DEBUG'],
    ['info', 'INFO'],
    ['error', 'ERROR'],
    ['fatal', 'CRITICAL'],
  ] as const)('maps %s to severity %s', (level, severity) => {
    const { lines, destination } = capture();
    createLogger({ level: 'trace', serviceName: 'svc', destination })[level]('x');

    expect(lines[0]?.severity).toBe(severity);
  });

  it('respects the configured level', () => {
    const { lines, destination } = capture();
    createLogger({ level: 'warn', serviceName: 'svc', destination }).info('hidden');

    expect(lines).toEqual([]);
  });
});

describe('LogPublisher', () => {
  it('logs the published message instead of sending it to a broker', async () => {
    const { lines, destination } = capture();
    const publisher = new LogPublisher(
      createLogger({ level: 'info', serviceName: 'svc', destination }),
    );

    const id = await publisher.publish('orders.transformed', {
      data: { hello: 'world' },
      attributes: { messageId: 'm-1' },
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines[0]).toMatchObject({
      topic: 'orders.transformed',
      publishedId: id,
      attributes: { messageId: 'm-1' },
      data: { hello: 'world' },
    });
    await publisher.close();
  });
});

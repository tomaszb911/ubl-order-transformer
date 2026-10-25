import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from '../../src/shutdown.js';
import { silentLogger } from '../helpers.js';

describe('createShutdownHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(close: () => Promise<void>, timeoutMs = 9000) {
    const exit = vi.fn<(code: number) => void>();
    const shutdown = createShutdownHandler({ close, logger: silentLogger, timeoutMs, exit });
    return { exit, shutdown };
  }

  it('exits with 0 once closing has finished', async () => {
    const close = vi.fn(() => Promise.resolve());
    const { exit, shutdown } = setup(close);

    shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('does not force an exit later when closing finished in time', async () => {
    const { exit, shutdown } = setup(() => Promise.resolve());

    shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('forces exit with 1 when closing hangs past the timeout', async () => {
    const { exit, shutdown } = setup(() => new Promise<void>(() => {}), 9000);

    shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(8999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits with 1 when closing fails', async () => {
    const { exit, shutdown } = setup(() => Promise.reject(new Error('flush failed')));

    shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('ignores further signals while shutting down', async () => {
    const close = vi.fn(() => Promise.resolve());
    const { exit, shutdown } = setup(close);

    shutdown('SIGTERM');
    shutdown('SIGINT');
    await vi.advanceTimersByTimeAsync(0);

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });
});

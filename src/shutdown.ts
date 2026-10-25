import type { Logger } from './application/ports.js';

export interface ShutdownOptions {
  /** Stops accepting requests, waits for in-flight ones and releases resources. */
  close: () => Promise<void>;
  logger: Logger;
  /** Force exit if `close` has not finished by then. */
  timeoutMs: number;
  /** Injectable for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Builds the SIGTERM/SIGINT handler.
 *
 * Cloud Run sends SIGTERM and kills the instance (SIGKILL) about 10 s later. If closing
 * hangs - e.g. flushing the Pub/Sub client while Pub/Sub is unreachable - the process
 * exits on its own just before that, with a log line explaining why, instead of being
 * killed silently.
 */
export function createShutdownHandler({
  close,
  logger,
  timeoutMs,
  exit = (code) => process.exit(code),
}: ShutdownOptions): (signal: string) => void {
  let shuttingDown = false;

  return (signal) => {
    // SIGTERM followed by SIGINT (or a repeated Ctrl+C) must not start a second shutdown.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, timeoutMs }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs }, 'Graceful shutdown timed out, forcing exit');
      exit(1);
    }, timeoutMs);
    // The timer alone must not keep the process alive once everything else has finished.
    forceExit.unref();

    close().then(
      () => {
        clearTimeout(forceExit);
        logger.info({}, 'Shutdown complete');
        exit(0);
      },
      (error: unknown) => {
        clearTimeout(forceExit);
        logger.error({ err: error }, 'Error during shutdown');
        exit(1);
      },
    );
  };
}

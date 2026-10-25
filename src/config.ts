export type PublisherMode = 'pubsub' | 'log';

export interface Config {
  port: number;
  logLevel: string;
  logPretty: boolean;
  serviceName: string;
  /** `pubsub` publishes to Google Cloud Pub/Sub (or the emulator); `log` only logs (mock). */
  publisher: PublisherMode;
  outputTopic: string;
  deadLetterTopic: string;
  maxDeliveryAttempts: number;
  idempotencyTtlSeconds: number;
  bodyLimitBytes: number;
  /** Graceful-shutdown budget; Cloud Run kills the instance ~10 s after SIGTERM. */
  shutdownTimeoutMs: number;
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

/** Reads and validates configuration from environment variables; fails fast on bad values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const int = (name: string, fallback: number, min: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
      problems.push(`${name} must be an integer >= ${min} (got '${raw}')`);
      return fallback;
    }
    return value;
  };

  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!(allowed as readonly string[]).includes(raw)) {
      problems.push(`${name} must be one of ${allowed.join(', ')} (got '${raw}')`);
      return fallback;
    }
    return raw as T;
  };

  const config: Config = {
    port: int('PORT', 8080, 1),
    logLevel: oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
    logPretty: env.LOG_PRETTY === 'true',
    serviceName: env.K_SERVICE ?? 'ubl-order-transformer',
    publisher: oneOf<PublisherMode>('PUBLISHER', ['pubsub', 'log'], 'pubsub'),
    outputTopic: env.OUTPUT_TOPIC || 'orders.transformed',
    deadLetterTopic: env.DEAD_LETTER_TOPIC || 'orders.failed',
    maxDeliveryAttempts: int('MAX_DELIVERY_ATTEMPTS', 5, 1),
    idempotencyTtlSeconds: int('IDEMPOTENCY_TTL_SECONDS', 24 * 60 * 60, 1),
    // Pub/Sub messages are at most 10 MB; the push envelope adds Base64 overhead.
    bodyLimitBytes: int('BODY_LIMIT_BYTES', 15 * 1024 * 1024, 1024),
    shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 9000, 1),
  };

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  }
  return config;
}

import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

/** pino level -> Cloud Logging severity (https://cloud.google.com/logging/docs/structured-logging). */
const SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

export interface LoggerConfig {
  level: string;
  pretty?: boolean;
  serviceName: string;
  /** Defaults to stdout; injectable for tests. */
  destination?: DestinationStream;
}

/**
 * JSON logs in the shape Cloud Logging understands natively: `severity`, `message`
 * and an RFC 3339 `time`, so Cloud Run logs are filterable by jsonPayload fields
 * (e.g. `jsonPayload.messageId="7a1e78c9"`).
 */
export function createLogger({
  level,
  pretty = false,
  serviceName,
  destination,
}: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level,
    messageKey: 'message',
    base: { service: serviceName },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (pretty) {
    // Human-readable output for local development (pino-pretty is a dev dependency).
    return pino({
      ...options,
      transport: { target: 'pino-pretty', options: { messageKey: 'message' } },
    });
  }
  const cloudLoggingOptions: LoggerOptions = {
    ...options,
    formatters: {
      level: (label) => ({ severity: SEVERITY[label] ?? 'DEFAULT' }),
    },
  };
  return destination === undefined
    ? pino(cloudLoggingOptions)
    : pino(cloudLoggingOptions, destination);
}

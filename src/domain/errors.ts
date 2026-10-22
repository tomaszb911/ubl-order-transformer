export type ErrorCode = 'InvalidBase64' | 'InvalidXml' | 'ValidationError' | 'ServerError';

/**
 * Base class for every failure the processing pipeline knows how to report.
 *
 * - `httpStatus` is what the HTTP endpoint returns (contract from the assignment).
 * - `retryable` tells the delivery policy whether another attempt could succeed:
 *   a malformed document will never become valid, a failed publish might.
 * - `detail` is internal diagnostic information: it is logged, never returned to the caller.
 */
export abstract class ProcessingError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  abstract readonly retryable: boolean;
  readonly detail: string | undefined;

  protected constructor(message: string, detail?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.detail = detail;
  }
}

export class InvalidBase64Error extends ProcessingError {
  readonly code = 'InvalidBase64';
  readonly httpStatus = 400;
  readonly retryable = false;

  constructor(detail?: string) {
    super('Document is not a valid Base64 string.', detail);
  }
}

export class InvalidXmlError extends ProcessingError {
  readonly code = 'InvalidXml';
  readonly httpStatus = 400;
  readonly retryable = false;

  constructor(detail?: string) {
    super('Message could not be parsed from XML to JSON.', detail);
  }
}

export class ValidationError extends ProcessingError {
  readonly code = 'ValidationError';
  readonly httpStatus = 400;
  readonly retryable = false;

  constructor(message: string) {
    super(message);
  }
}

export class ServerError extends ProcessingError {
  readonly code = 'ServerError';
  readonly httpStatus = 500;
  readonly retryable = true;

  constructor(detail?: string, options?: ErrorOptions) {
    super('An unexpected error occurred.', detail, options);
  }
}

/** Normalises anything thrown during processing into a ProcessingError. */
export function toProcessingError(error: unknown): ProcessingError {
  if (error instanceof ProcessingError) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ServerError(detail, { cause: error });
}

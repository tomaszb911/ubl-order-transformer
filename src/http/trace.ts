import type { IncomingHttpHeaders } from 'node:http';

/** Special log fields Cloud Logging uses to group entries per request and link them to Cloud Trace. */
export const TRACE_FIELD = 'logging.googleapis.com/trace';
export const SPAN_FIELD = 'logging.googleapis.com/spanId';
export const SAMPLED_FIELD = 'logging.googleapis.com/trace_sampled';

// W3C Trace Context: 00-<32 hex trace id>-<16 hex span id>-<2 hex flags>
const TRACEPARENT_PATTERN = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
// Legacy Google header: <32 hex trace id>/<decimal span id>;o=<0|1>
const CLOUD_TRACE_PATTERN = /^([0-9a-f]{32})(?:\/(\d{1,20}))?(?:;o=([01]))?$/i;

interface TraceContext {
  traceId: string;
  spanId?: string;
  sampled?: boolean;
}

/**
 * Log fields correlating a request's log lines with its Cloud Run trace.
 * Returns no fields when the project is unknown (e.g. locally) or the request carries no
 * valid trace header, so logging works the same everywhere.
 */
export function traceLogFields(
  headers: IncomingHttpHeaders,
  projectId: string | undefined,
): Record<string, string | boolean> {
  if (projectId === undefined) return {};

  const trace =
    fromTraceparent(headers.traceparent) ?? fromCloudTrace(headers['x-cloud-trace-context']);
  if (trace === undefined) return {};

  return {
    [TRACE_FIELD]: `projects/${projectId}/traces/${trace.traceId}`,
    ...(trace.spanId !== undefined && { [SPAN_FIELD]: trace.spanId }),
    ...(trace.sampled !== undefined && { [SAMPLED_FIELD]: trace.sampled }),
  };
}

function fromTraceparent(header: string | string[] | undefined): TraceContext | undefined {
  const match = typeof header === 'string' ? TRACEPARENT_PATTERN.exec(header.trim()) : null;
  if (match === null) return undefined;
  // The pattern guarantees all three groups; the defaults only satisfy the type checker.
  const [, traceId = '', spanId = '', flags = '00'] = match;
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    // Bit 0 of the flags byte is "sampled".
    sampled: (Number.parseInt(flags, 16) & 1) === 1,
  };
}

function fromCloudTrace(header: string | string[] | undefined): TraceContext | undefined {
  const match = typeof header === 'string' ? CLOUD_TRACE_PATTERN.exec(header.trim()) : null;
  if (match === null) return undefined;
  const [, traceId = '', decimalSpanId, sampled] = match;
  return {
    traceId: traceId.toLowerCase(),
    // Cloud Logging expects the span id as 16 hex digits; this header carries it in decimal.
    ...(decimalSpanId !== undefined && {
      spanId: BigInt(decimalSpanId).toString(16).padStart(16, '0'),
    }),
    ...(sampled !== undefined && { sampled: sampled === '1' }),
  };
}

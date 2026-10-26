import { describe, expect, it } from 'vitest';
import { SAMPLED_FIELD, SPAN_FIELD, TRACE_FIELD, traceLogFields } from '../../src/http/trace.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

describe('traceLogFields', () => {
  it('reads the W3C traceparent header', () => {
    expect(
      traceLogFields({ traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01` }, 'my-project'),
    ).toEqual({
      [TRACE_FIELD]: `projects/my-project/traces/${TRACE_ID}`,
      [SPAN_FIELD]: '00f067aa0ba902b7',
      [SAMPLED_FIELD]: true,
    });
  });

  it('reads the "not sampled" flag from traceparent', () => {
    const fields = traceLogFields({ traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-00` }, 'p');
    expect(fields[SAMPLED_FIELD]).toBe(false);
  });

  it('falls back to X-Cloud-Trace-Context, converting the decimal span id to hex', () => {
    expect(
      traceLogFields({ 'x-cloud-trace-context': `${TRACE_ID}/12345;o=1` }, 'my-project'),
    ).toEqual({
      [TRACE_FIELD]: `projects/my-project/traces/${TRACE_ID}`,
      [SPAN_FIELD]: '0000000000003039',
      [SAMPLED_FIELD]: true,
    });
  });

  it('accepts X-Cloud-Trace-Context with the trace id only', () => {
    expect(traceLogFields({ 'x-cloud-trace-context': TRACE_ID }, 'p')).toEqual({
      [TRACE_FIELD]: `projects/p/traces/${TRACE_ID}`,
    });
  });

  it('prefers traceparent when both headers are present', () => {
    const fields = traceLogFields(
      {
        traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01`,
        'x-cloud-trace-context': `${'f'.repeat(32)}/1;o=1`,
      },
      'p',
    );
    expect(fields[TRACE_FIELD]).toBe(`projects/p/traces/${TRACE_ID}`);
  });

  it('returns nothing without a project id (local runs)', () => {
    expect(
      traceLogFields({ traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01` }, undefined),
    ).toEqual({});
  });

  it.each([
    ['no header', {}],
    ['malformed traceparent', { traceparent: 'garbage' }],
    ['malformed X-Cloud-Trace-Context', { 'x-cloud-trace-context': 'not-a-trace/1;o=1' }],
  ])('returns nothing for %s', (_case, headers) => {
    expect(traceLogFields(headers, 'p')).toEqual({});
  });
});

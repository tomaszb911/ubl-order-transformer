import { describe, expect, it } from 'vitest';
import type { DeadLetterRecord } from '../../src/application/order-processor.js';
import { type PulledDeadLetter, planReplay } from '../../scripts/lib/replay.js';

function deadLetter(ackId: string, overrides: Partial<DeadLetterRecord> = {}): PulledDeadLetter {
  const record: DeadLetterRecord = {
    messageId: `msg-${ackId}`,
    failedAt: '2026-10-26T10:00:00Z',
    error: { code: 'ServerError', message: 'An unexpected error occurred.' },
    deliveryAttempt: 5,
    source: 'pubsub-push',
    pubsubMessageId: `ps-${ackId}`,
    originalMessage: { messageId: `msg-${ackId}`, document: 'PD94...' },
    ...overrides,
  };
  return { ackId, data: JSON.stringify(record) };
}

describe('planReplay', () => {
  it('replays the original business message of every record', () => {
    const plan = planReplay([deadLetter('1'), deadLetter('2')]);

    expect(plan.skip).toEqual([]);
    expect(plan.replay.map(({ ackId, message }) => ({ ackId, message }))).toEqual([
      { ackId: '1', message: { messageId: 'msg-1', document: 'PD94...' } },
      { ackId: '2', message: { messageId: 'msg-2', document: 'PD94...' } },
    ]);
  });

  it('filters by error code, leaving the others in the subscription', () => {
    const plan = planReplay(
      [
        deadLetter('1'),
        deadLetter('2', { error: { code: 'InvalidXml', message: 'Message could not be parsed.' } }),
      ],
      { errorCode: 'ServerError' },
    );

    expect(plan.replay.map(({ ackId }) => ackId)).toEqual(['1']);
    expect(plan.skip).toEqual([
      { ackId: '2', messageId: 'msg-2', reason: 'error code InvalidXml is not ServerError' },
    ]);
  });

  it('filters by messageId', () => {
    const plan = planReplay([deadLetter('1'), deadLetter('2')], { messageId: 'msg-2' });

    expect(plan.replay.map(({ ackId }) => ackId)).toEqual(['2']);
    expect(plan.skip).toEqual([
      { ackId: '1', messageId: 'msg-1', reason: 'messageId is not msg-2' },
    ]);
  });

  it.each([
    ['a string', 'not an object'],
    ['null', null],
    ['a push envelope', { message: { data: 'eyJ9' } }],
  ])('skips records whose original message is %s', (_case, originalMessage) => {
    const plan = planReplay([deadLetter('1', { originalMessage })]);

    expect(plan.replay).toEqual([]);
    expect(plan.skip).toEqual([
      { ackId: '1', messageId: 'msg-1', reason: 'no original business message to replay' },
    ]);
  });

  it('skips data that is not JSON', () => {
    const plan = planReplay([{ ackId: '1', data: '<not json>' }]);

    expect(plan.skip).toEqual([
      { ackId: '1', messageId: null, reason: 'not a JSON dead-letter record' },
    ]);
  });

  it('keeps records without a messageId replayable (the service will reject them again)', () => {
    const plan = planReplay([
      deadLetter('1', { messageId: null, originalMessage: { document: 'x' } }),
    ]);

    expect(plan.replay).toHaveLength(1);
  });
});

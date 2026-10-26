import type { DeadLetterRecord } from '../../src/application/order-processor.js';

/** A message pulled from a subscription on the dead-letter topic. */
export interface PulledDeadLetter {
  ackId: string;
  /** Message data as text (a JSON DeadLetterRecord written by the service). */
  data: string;
}

export interface ReplayFilters {
  /** Only replay the message with this business messageId. */
  messageId?: string;
  /** Only replay messages that failed with this error code (e.g. ServerError). */
  errorCode?: string;
}

export interface ReplayCandidate {
  ackId: string;
  record: DeadLetterRecord;
  /** The business message to publish again to the input topic. */
  message: Record<string, unknown>;
}

export interface SkippedDeadLetter {
  ackId: string;
  messageId: string | null;
  reason: string;
}

export interface ReplayPlan {
  replay: ReplayCandidate[];
  /** Left in the dead-letter subscription (not acknowledged). */
  skip: SkippedDeadLetter[];
}

/**
 * Decides which dead-lettered messages to replay. Pure function, so the selection rules are
 * unit-tested without Pub/Sub; the script only executes the plan.
 */
export function planReplay(pulled: PulledDeadLetter[], filters: ReplayFilters = {}): ReplayPlan {
  const plan: ReplayPlan = { replay: [], skip: [] };

  for (const { ackId, data } of pulled) {
    let record: DeadLetterRecord;
    try {
      record = JSON.parse(data) as DeadLetterRecord;
    } catch {
      plan.skip.push({ ackId, messageId: null, reason: 'not a JSON dead-letter record' });
      continue;
    }

    const messageId = typeof record.messageId === 'string' ? record.messageId : null;
    const skip = (reason: string) => plan.skip.push({ ackId, messageId, reason });

    if (filters.messageId !== undefined && messageId !== filters.messageId) {
      skip(`messageId is not ${filters.messageId}`);
    } else if (filters.errorCode !== undefined && record.error?.code !== filters.errorCode) {
      skip(`error code ${record.error?.code ?? 'unknown'} is not ${filters.errorCode}`);
    } else if (!isBusinessMessage(record.originalMessage)) {
      // e.g. a body that could not even be read as a message: nothing sensible to re-publish.
      skip('no original business message to replay');
    } else {
      plan.replay.push({ ackId, record, message: record.originalMessage });
    }
  }

  return plan;
}

/** A business message is a JSON object that is not a Pub/Sub push envelope. */
function isBusinessMessage(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !('message' in value)
  );
}

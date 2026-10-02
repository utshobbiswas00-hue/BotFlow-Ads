import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-FREE unit tests for the notification processor's broadcast instrumentation.
 *
 * The single most important property here: an ORDINARY notification must be a
 * complete no-op with respect to broadcast tracking. The branch is keyed on the
 * presence of a broadcast recipient id, and these tests pin both sides:
 *  - without the id, `deliverToTelegram` runs and NONE of the tracking functions
 *    are ever called;
 *  - with the id, the tracked delivery runs and the outcome is recorded.
 *
 * All services are mocked; the processor is imported directly (the worker
 * bootstrap, which opens Redis, is a separate module).
 */

// `vi.mock` factories are hoisted above these declarations, so the shared spies
// must be created with `vi.hoisted` (a plain top-level `const` is not yet
// initialized when the factory runs).
const mocks = vi.hoisted(() => ({
  deliverToTelegram: vi.fn(),
  deliverBroadcastMessage: vi.fn(),
  createBulkNotifications: vi.fn(),
  alertAdmins: vi.fn(),
  markBroadcastRunning: vi.fn(async () => undefined),
  recomputeBroadcastJob: vi.fn(async () => undefined),
  recordBroadcastOutcome: vi.fn(async () => undefined),
}));

vi.mock('../../services/notification.service', () => ({
  deliverToTelegram: mocks.deliverToTelegram,
  deliverBroadcastMessage: mocks.deliverBroadcastMessage,
  createBulkNotifications: mocks.createBulkNotifications,
  alertAdmins: mocks.alertAdmins,
}));

vi.mock('../../services/broadcast.service', () => ({
  markBroadcastRunning: mocks.markBroadcastRunning,
  recomputeBroadcastJob: mocks.recomputeBroadcastJob,
  recordBroadcastOutcome: mocks.recordBroadcastOutcome,
}));

vi.mock('../../utils/mailer', () => ({ sendMail: vi.fn(async () => ({ sent: true })) }));

const {
  deliverToTelegram,
  deliverBroadcastMessage,
  createBulkNotifications,
  markBroadcastRunning,
  recomputeBroadcastJob,
  recordBroadcastOutcome,
} = mocks;

import { processor } from '../notification.processor';
import { JOB, NOTIFICATION_JOBS } from '../../queues/names';

function fakeJob(name: string, data: Record<string, unknown>) {
  return { id: 'queue-1', name, data } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  deliverToTelegram.mockResolvedValue(true);
  createBulkNotifications.mockResolvedValue(undefined);
});

/* ------------------------------------------------------------------ */
/* the no-op                                                           */
/* ------------------------------------------------------------------ */

describe('non-broadcast notification is untouched', () => {
  it('delivers via deliverToTelegram and NEVER touches broadcast tracking', async () => {
    await processor(
      fakeJob(JOB.SEND_TELEGRAM_NOTIFICATION, {
        userId: 'u1',
        type: 'SYSTEM',
        title: 'Hi',
        body: 'There',
      }),
    );

    expect(deliverToTelegram).toHaveBeenCalledTimes(1);
    expect(deliverToTelegram).toHaveBeenCalledWith({
      userId: 'u1',
      type: 'SYSTEM',
      title: 'Hi',
      body: 'There',
      data: undefined,
    });

    // The whole tracking path must be inert for an ordinary notification.
    expect(deliverBroadcastMessage).not.toHaveBeenCalled();
    expect(recordBroadcastOutcome).not.toHaveBeenCalled();
    expect(markBroadcastRunning).not.toHaveBeenCalled();
    expect(recomputeBroadcastJob).not.toHaveBeenCalled();
  });

  it('does not enter tracking even if only ONE of the two ids is present', async () => {
    await processor(
      fakeJob(JOB.SEND_TELEGRAM_NOTIFICATION, {
        userId: 'u1',
        type: 'SYSTEM',
        title: 'Hi',
        body: 'There',
        broadcastRecipientId: 'rec-1', // no job id
      }),
    );

    expect(deliverBroadcastMessage).not.toHaveBeenCalled();
    expect(recordBroadcastOutcome).not.toHaveBeenCalled();
    expect(deliverToTelegram).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* tracked broadcast sends                                             */
/* ------------------------------------------------------------------ */

describe('broadcast notification records its outcome', () => {
  it('records SENT and does not throw', async () => {
    deliverBroadcastMessage.mockResolvedValue({
      status: 'SENT',
      telegramMessageId: 555n,
      error: null,
    });

    await processor(
      fakeJob(JOB.SEND_TELEGRAM_NOTIFICATION, {
        userId: 'u1',
        type: 'SYSTEM',
        title: 'Hi',
        body: 'There',
        broadcastJobId: 'job-1',
        broadcastRecipientId: 'rec-1',
      }),
    );

    expect(deliverBroadcastMessage).toHaveBeenCalledTimes(1);
    expect(deliverToTelegram).not.toHaveBeenCalled();
    expect(recordBroadcastOutcome).toHaveBeenCalledWith({
      jobId: 'job-1',
      recipientId: 'rec-1',
      status: 'SENT',
      telegramMessageId: 555n,
      error: null,
    });
  });

  it('records SKIPPED (blocked/gone) and completes without retrying', async () => {
    deliverBroadcastMessage.mockResolvedValue({
      status: 'SKIPPED',
      telegramMessageId: null,
      error: '403: Forbidden: bot was blocked by the user',
    });

    await expect(
      processor(
        fakeJob(JOB.SEND_TELEGRAM_NOTIFICATION, {
          userId: 'u1',
          type: 'SYSTEM',
          title: 'Hi',
          body: 'There',
          broadcastJobId: 'job-1',
          broadcastRecipientId: 'rec-2',
        }),
      ),
    ).resolves.toBeUndefined();

    expect(recordBroadcastOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'rec-2', status: 'SKIPPED' }),
    );
  });

  it('records FAILED and rethrows so BullMQ can retry', async () => {
    deliverBroadcastMessage.mockResolvedValue({
      status: 'FAILED',
      telegramMessageId: null,
      error: 'Timeout',
    });

    await expect(
      processor(
        fakeJob(JOB.SEND_TELEGRAM_NOTIFICATION, {
          userId: 'u1',
          type: 'SYSTEM',
          title: 'Hi',
          body: 'There',
          broadcastJobId: 'job-1',
          broadcastRecipientId: 'rec-3',
        }),
      ),
    ).rejects.toThrow(/broadcast delivery failed/);

    // The outcome is recorded BEFORE the throw, so the report is not left blank.
    expect(recordBroadcastOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'rec-3', status: 'FAILED', error: 'Timeout' }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* the send-broadcast fan-out                                          */
/* ------------------------------------------------------------------ */

describe('send-broadcast fan-out', () => {
  it('marks the job RUNNING and fans out with per-recipient ids', async () => {
    await processor(
      fakeJob(JOB.BROADCAST, {
        title: 'Hi',
        body: 'There',
        audience: 'ALL',
        userIds: ['u1', 'u2'],
        broadcastJobId: 'job-1',
        recipients: [
          { userId: 'u1', recipientId: 'rec-1' },
          { userId: 'u2', recipientId: 'rec-2' },
        ],
      }),
    );

    expect(markBroadcastRunning).toHaveBeenCalledWith('job-1');
    expect(createBulkNotifications).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'u1', broadcastJobId: 'job-1', broadcastRecipientId: 'rec-1' }),
      expect.objectContaining({ userId: 'u2', broadcastJobId: 'job-1', broadcastRecipientId: 'rec-2' }),
    ]);
  });

  it('an untracked send-broadcast preserves the old payload shape', async () => {
    await processor(
      fakeJob(JOB.BROADCAST, {
        title: 'Hi',
        body: 'There',
        audience: 'ALL',
        userIds: ['u1'],
      }),
    );

    expect(markBroadcastRunning).not.toHaveBeenCalled();
    const inputs = createBulkNotifications.mock.calls[0]![0] as Record<string, unknown>[];
    expect(inputs[0]).toEqual({ userId: 'u1', type: 'SYSTEM', title: 'Hi', body: 'There' });
    expect('broadcastRecipientId' in (inputs[0] as object)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* the job-name parity guard                                           */
/* ------------------------------------------------------------------ */

/**
 * One valid payload per notification job, keyed by the JOB constant (never a
 * string literal), so a wired job is driven for real rather than tripping a
 * payload guard.
 */
const NOTIFICATION_JOB_PAYLOAD: Record<string, Record<string, unknown>> = {
  [JOB.SEND_TELEGRAM_NOTIFICATION]: {
    userId: 'u1',
    type: 'SYSTEM',
    title: 'Hi',
    body: 'There',
  },
  [JOB.SEND_EMAIL_NOTIFICATION]: { to: 'a@b.test', subject: 'Hi', html: '<p>There</p>' },
  [JOB.BROADCAST_ADMIN_ALERT]: { text: 'ops note' },
  [JOB.BROADCAST]: { title: 'Hi', body: 'There', audience: 'ALL', userIds: ['u1'] },
};

describe('notification job-name parity', () => {
  it('handles every job name in the notification set (read from names.ts)', async () => {
    // The list comes from the real constant, so a job added there but never
    // wired into the processor falls through to the default and fails here.
    for (const name of NOTIFICATION_JOBS) {
      const data = NOTIFICATION_JOB_PAYLOAD[name] ?? {};
      await expect(processor(fakeJob(name, data))).resolves.toBeUndefined();
    }
  });

  it('rejects an unknown job name through the default case', async () => {
    await expect(
      processor(fakeJob('definitely-not-a-notification-job', {})),
    ).rejects.toThrow(/unknown notification job/);
  });
});

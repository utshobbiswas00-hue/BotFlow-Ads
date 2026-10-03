import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

/**
 * DB-FREE unit tests for broadcast delivery tracking (spec §52).
 *
 * Prisma, the audit service, the queue producers, Telegram and the mailer are
 * all mocked — nothing connects. The tests pin:
 *  - job + recipient creation in one transaction, with PENDING rows and a total;
 *  - counter/status recompute from the recipient rows (never an increment);
 *  - the per-status `groupBy` aggregation;
 *  - the three report endpoints (pagination, status filter, 404);
 *  - that a NON-broadcast notification's queued payload is unchanged.
 */

/**
 * Everything mutable is created via `vi.hoisted` so the `vi.mock` factories
 * (which vitest hoists to the top of the file) can reference it safely.
 */
const mocks = vi.hoisted(() => ({
  broadcastJobCreate: vi.fn(),
  broadcastJobFindUnique: vi.fn(),
  broadcastJobFindMany: vi.fn(),
  broadcastJobCount: vi.fn(),
  broadcastJobUpdate: vi.fn(),
  broadcastJobUpdateMany: vi.fn(),
  broadcastRecipientCreate: vi.fn(),
  broadcastRecipientUpdate: vi.fn(),
  broadcastRecipientFindMany: vi.fn(),
  broadcastRecipientCount: vi.fn(),
  broadcastRecipientGroupBy: vi.fn(),
  userCount: vi.fn(),
  userFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  notificationCreateMany: vi.fn(),
  notificationUpdateMany: vi.fn(),
  notificationFindFirst: vi.fn(),
  notificationUpdate: vi.fn(),
  transaction: vi.fn(),
  enqueueBroadcast: vi.fn(async () => 'broadcast:queue'),
  enqueueNotification: vi.fn(async (_payload: Record<string, unknown>) => undefined),
  // The bulk fan-out uses the strict variant, which reports whether the queue accepted
  // the job: a recipient whose push never got queued is undelivered, not pending, and the
  // broadcast has to record that. Resolves true so these tests cover the queued path.
  enqueueNotificationStrict: vi.fn(async (_payload: Record<string, unknown>) => true),
  sendUserMessage: vi.fn(async () => true),
  sendUserMessageDetailed: vi.fn(),
  sendMail: vi.fn(async () => ({ sent: false, reason: 'email disabled' })),
  sendTransactionalEmail: vi.fn(async () => undefined),
}));

vi.mock('../../db/prisma', () => ({
  prisma: {
    broadcastJob: {
      create: mocks.broadcastJobCreate,
      findUnique: mocks.broadcastJobFindUnique,
      findMany: mocks.broadcastJobFindMany,
      count: mocks.broadcastJobCount,
      update: mocks.broadcastJobUpdate,
      updateMany: mocks.broadcastJobUpdateMany,
    },
    broadcastRecipient: {
      create: mocks.broadcastRecipientCreate,
      update: mocks.broadcastRecipientUpdate,
      findMany: mocks.broadcastRecipientFindMany,
      count: mocks.broadcastRecipientCount,
      groupBy: mocks.broadcastRecipientGroupBy,
    },
    user: {
      count: mocks.userCount,
      findMany: mocks.userFindMany,
      findUnique: mocks.userFindUnique,
    },
    notification: {
      createMany: mocks.notificationCreateMany,
      updateMany: mocks.notificationUpdateMany,
      // `deliverToTelegram` marks exactly one row as delivered, by id, rather than
      // updateMany-ing every undelivered row that shares the same type/title/body.
      findFirst: mocks.notificationFindFirst,
      update: mocks.notificationUpdate,
    },
    $transaction: mocks.transaction,
  },
  transaction: vi.fn(),
}));

vi.mock('../../services/audit.service', () => ({ recordAudit: vi.fn(async () => undefined) }));

vi.mock('../../queues/producers', () => ({
  enqueueBroadcast: mocks.enqueueBroadcast,
  enqueueNotification: mocks.enqueueNotification,
  enqueueNotificationStrict: mocks.enqueueNotificationStrict,
}));

vi.mock('../../middleware/adminAuth', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../utils/telegram', () => ({
  sendUserMessage: mocks.sendUserMessage,
  sendUserMessageDetailed: mocks.sendUserMessageDetailed,
}));

vi.mock('../../utils/mailer', () => ({
  notificationEmailHtml: vi.fn(() => ''),
  sendMail: mocks.sendMail,
}));

vi.mock('../../services/email.service', () => ({
  sendTransactionalEmail: mocks.sendTransactionalEmail,
}));

const {
  broadcastJobCreate,
  broadcastJobFindUnique,
  broadcastJobFindMany,
  broadcastJobCount,
  broadcastJobUpdate,
  broadcastRecipientCreate,
  broadcastRecipientUpdate,
  broadcastRecipientFindMany,
  broadcastRecipientCount,
  broadcastRecipientGroupBy,
  notificationCreateMany,
  notificationFindFirst,
  notificationUpdate,
  notificationUpdateMany,
  userFindUnique,
  enqueueNotification,
  enqueueNotificationStrict,
} = mocks;

import {
  countsFromGroupBy,
  createBroadcastJob,
  getBroadcastJob,
  listBroadcastHistory,
  listBroadcastRecipients,
  recomputeBroadcastJob,
  recordBroadcastOutcome,
} from '../broadcast.service';
import {
  getBroadcastJobHandler,
  listBroadcastHistoryHandler,
  listBroadcastRecipientsHandler,
} from '../../routes/admin/broadcast.routes';
import {
  createBulkNotifications,
  classifyUserMessageResult,
  deliverToTelegram,
} from '../notification.service';
import { getPagination } from '../../utils/pagination';
import { BroadcastJobStatus, BroadcastRecipientStatus } from '@prisma/client';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function fakeRes(): Response & { body?: { ok: boolean; data: unknown } } {
  const res = {
    json: vi.fn((body: unknown) => {
      (res as { body?: unknown }).body = body;
      return res;
    }),
  } as unknown as Response & { body?: { ok: boolean; data: unknown } };
  return res;
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return { query: {}, params: {}, ...overrides } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/* job + recipient creation                                            */
/* ------------------------------------------------------------------ */

describe('createBroadcastJob', () => {
  it('creates the job and one PENDING recipient per user, in ONE transaction, and returns the mapping', async () => {
    const tx = {
      broadcastJob: { create: broadcastJobCreate },
      broadcastRecipient: { create: broadcastRecipientCreate },
    };
    mocks.transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));

    broadcastJobCreate.mockResolvedValue({ id: 'job-1' });
    broadcastRecipientCreate
      .mockResolvedValueOnce({ id: 'rec-1', userId: 'u1' })
      .mockResolvedValueOnce({ id: 'rec-2', userId: 'u2' });

    const result = await createBroadcastJob({
      title: 'Maintenance',
      body: 'Down at 22:00',
      audience: 'ALL',
      createdById: 'admin-1',
      userIds: ['u1', 'u2'],
    });

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(broadcastJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'Maintenance',
          totalRecipients: 2,
          createdById: 'admin-1',
          status: BroadcastJobStatus.QUEUED,
        }),
      }),
    );
    expect(broadcastRecipientCreate).toHaveBeenCalledTimes(2);
    expect(broadcastRecipientCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: { jobId: 'job-1', userId: 'u1', status: BroadcastRecipientStatus.PENDING },
      }),
    );
    expect(result).toEqual({
      jobId: 'job-1',
      recipients: [
        { userId: 'u1', recipientId: 'rec-1' },
        { userId: 'u2', recipientId: 'rec-2' },
      ],
    });
  });

  it('creates a job with zero recipients when the audience is empty', async () => {
    const tx = {
      broadcastJob: { create: broadcastJobCreate },
      broadcastRecipient: { create: broadcastRecipientCreate },
    };
    mocks.transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));
    broadcastJobCreate.mockResolvedValue({ id: 'job-0' });

    const result = await createBroadcastJob({
      title: 't',
      body: 'b',
      audience: 'ALL',
      createdById: null,
      userIds: [],
    });

    expect(result).toEqual({ jobId: 'job-0', recipients: [] });
    expect(broadcastJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalRecipients: 0 }) }),
    );
    expect(broadcastRecipientCreate).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* per-status groupBy + recompute                                      */
/* ------------------------------------------------------------------ */

describe('countsFromGroupBy', () => {
  it('folds a groupBy result into per-status counts and a total', () => {
    expect(
      countsFromGroupBy([
        { status: 'PENDING', _count: { _all: 1 } },
        { status: 'SENT', _count: { _all: 3 } },
        { status: 'FAILED', _count: { _all: 2 } },
        { status: 'SKIPPED', _count: { _all: 4 } },
      ]),
    ).toEqual({ total: 10, pending: 1, sent: 3, failed: 2, skipped: 4 });
  });

  it('ignores an unknown status but still counts it in the total', () => {
    const counts = countsFromGroupBy([{ status: 'WEIRD', _count: { _all: 2 } }]);
    expect(counts.total).toBe(2);
  });
});

describe('recomputeBroadcastJob', () => {
  it('keeps the job RUNNING while recipients are still PENDING', async () => {
    broadcastRecipientGroupBy.mockResolvedValue([
      { status: 'SENT', _count: { _all: 2 } },
      { status: 'PENDING', _count: { _all: 1 } },
    ]);
    broadcastJobUpdate.mockResolvedValue({});

    const counts = await recomputeBroadcastJob('job-1');

    expect(counts).toEqual({ total: 3, pending: 1, sent: 2, failed: 0, skipped: 0 });
    expect(broadcastJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        sentCount: 2,
        failedCount: 0,
        status: BroadcastJobStatus.RUNNING,
        completedAt: null,
      }),
    });
  });

  it('marks COMPLETED with no failures, and sets completedAt', async () => {
    broadcastRecipientGroupBy.mockResolvedValue([
      { status: 'SENT', _count: { _all: 2 } },
      { status: 'SKIPPED', _count: { _all: 1 } },
    ]);
    broadcastJobUpdate.mockResolvedValue({});

    await recomputeBroadcastJob('job-1');

    const data = broadcastJobUpdate.mock.calls[0]![0].data as {
      status: string;
      completedAt: Date | null;
    };
    expect(data.status).toBe(BroadcastJobStatus.COMPLETED);
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it('marks FAILED when at least one recipient failed, and tracks failedCount', async () => {
    broadcastRecipientGroupBy.mockResolvedValue([
      { status: 'SENT', _count: { _all: 5 } },
      { status: 'FAILED', _count: { _all: 2 } },
    ]);
    broadcastJobUpdate.mockResolvedValue({});

    const counts = await recomputeBroadcastJob('job-1');

    expect(counts.failed).toBe(2);
    expect(broadcastJobUpdate.mock.calls[0]![0].data).toEqual(
      expect.objectContaining({
        sentCount: 5,
        failedCount: 2,
        status: BroadcastJobStatus.FAILED,
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* recording an outcome — and the must-not-throw guarantee             */
/* ------------------------------------------------------------------ */

describe('recordBroadcastOutcome', () => {
  it('records SENT with the Telegram message id and a sentAt stamp', async () => {
    broadcastRecipientUpdate.mockResolvedValue({});
    broadcastRecipientGroupBy.mockResolvedValue([{ status: 'SENT', _count: { _all: 1 } }]);
    broadcastJobUpdate.mockResolvedValue({});

    await recordBroadcastOutcome({
      jobId: 'job-1',
      recipientId: 'rec-1',
      status: 'SENT',
      telegramMessageId: 987654321n,
      error: null,
    });

    expect(broadcastRecipientUpdate).toHaveBeenCalledWith({
      where: { id: 'rec-1' },
      data: expect.objectContaining({
        status: BroadcastRecipientStatus.SENT,
        telegramMessageId: 987654321n,
        error: null,
        sentAt: expect.any(Date),
      }),
    });
    // and refreshes the job counters afterwards
    expect(broadcastJobUpdate).toHaveBeenCalled();
  });

  it('records FAILED with Telegram\'s description and no message id', async () => {
    broadcastRecipientUpdate.mockResolvedValue({});
    broadcastRecipientGroupBy.mockResolvedValue([{ status: 'FAILED', _count: { _all: 1 } }]);
    broadcastJobUpdate.mockResolvedValue({});

    await recordBroadcastOutcome({
      jobId: 'job-1',
      recipientId: 'rec-2',
      status: 'FAILED',
      error: '400: Bad Request: message text is empty',
    });

    expect(broadcastRecipientUpdate).toHaveBeenCalledWith({
      where: { id: 'rec-2' },
      data: expect.objectContaining({
        status: BroadcastRecipientStatus.FAILED,
        telegramMessageId: null,
        error: '400: Bad Request: message text is empty',
      }),
    });
  });

  it('records SKIPPED when the recipient could not be reached', async () => {
    broadcastRecipientUpdate.mockResolvedValue({});
    broadcastRecipientGroupBy.mockResolvedValue([{ status: 'SKIPPED', _count: { _all: 1 } }]);
    broadcastJobUpdate.mockResolvedValue({});

    await recordBroadcastOutcome({
      jobId: 'job-1',
      recipientId: 'rec-3',
      status: 'SKIPPED',
      error: '403: Forbidden: bot was blocked by the user',
    });

    expect(broadcastRecipientUpdate).toHaveBeenCalledWith({
      where: { id: 'rec-3' },
      data: expect.objectContaining({
        status: BroadcastRecipientStatus.SKIPPED,
        telegramMessageId: null,
        error: '403: Forbidden: bot was blocked by the user',
      }),
    });
  });

  it('NEVER throws when the tracking write fails — the notification is more important', async () => {
    broadcastRecipientUpdate.mockRejectedValue(new Error('db down'));

    await expect(
      recordBroadcastOutcome({ jobId: 'job-1', recipientId: 'rec-1', status: 'SENT' }),
    ).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* reading: history / detail / recipients                              */
/* ------------------------------------------------------------------ */

describe('listBroadcastHistory', () => {
  it('paginates newest first and uses the pagination skip/take', async () => {
    broadcastJobCount.mockResolvedValue(30);
    broadcastJobFindMany.mockResolvedValue([{ id: 'j1' }] as never);

    const result = await listBroadcastHistory(getPagination({ page: 2, limit: 10 }));

    expect(broadcastJobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 10, take: 10 }),
    );
    expect(result).toEqual({ items: [{ id: 'j1' }], page: 2, limit: 10, total: 30, hasMore: true });
  });
});

describe('getBroadcastJob', () => {
  it('returns the job AND live groupBy counts side by side (drift visible)', async () => {
    broadcastJobFindUnique.mockResolvedValue({ id: 'job-1', sentCount: 1, failedCount: 0 });
    broadcastRecipientGroupBy.mockResolvedValue([
      { status: 'SENT', _count: { _all: 2 } },
      { status: 'FAILED', _count: { _all: 1 } },
      { status: 'PENDING', _count: { _all: 1 } },
    ]);

    const { job, counts } = await getBroadcastJob('job-1');

    expect(job.sentCount).toBe(1); // the denormalised column, deliberately kept
    expect(counts).toEqual({ total: 4, pending: 1, sent: 2, failed: 1, skipped: 0 });
  });

  it('throws a 404 for an unknown job', async () => {
    broadcastJobFindUnique.mockResolvedValue(null);
    await expect(getBroadcastJob('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('listBroadcastRecipients', () => {
  it('filters by status and joins only the display-name fields', async () => {
    broadcastJobFindUnique.mockResolvedValue({ id: 'job-1' });
    broadcastRecipientCount.mockResolvedValue(1);
    broadcastRecipientFindMany.mockResolvedValue([
      {
        id: 'rec-1',
        userId: 'u1',
        status: 'FAILED',
        telegramMessageId: null,
        error: 'boom',
        sentAt: null,
        createdAt: new Date('2026-10-02T00:00:00Z'),
        user: { firstName: 'Ada', lastName: 'Lovelace', username: 'ada' },
      },
    ] as never);

    const result = await listBroadcastRecipients(
      'job-1',
      getPagination({ page: 1, limit: 20 }),
      'FAILED' as never,
    );

    const findArgs = broadcastRecipientFindMany.mock.calls[0]![0] as {
      where: { jobId: string; status?: string };
      select: Record<string, unknown>;
    };
    expect(findArgs.where).toEqual({ jobId: 'job-1', status: 'FAILED' });
    // Only display-name fields are joined — never a telegram id or email.
    expect(findArgs.select.user).toEqual({
      select: { firstName: true, lastName: true, username: true },
    });
    expect(result.items[0]!.userName).toBe('Ada Lovelace');
  });

  it('throws a 404 for an unknown job', async () => {
    broadcastJobFindUnique.mockResolvedValue(null);
    await expect(
      listBroadcastRecipients('nope', getPagination({}), undefined),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

/* ------------------------------------------------------------------ */
/* the three endpoints (handlers, without a live server)               */
/* ------------------------------------------------------------------ */

describe('broadcast report endpoints', () => {
  it('GET /history returns a paginated envelope', async () => {
    broadcastJobCount.mockResolvedValue(1);
    broadcastJobFindMany.mockResolvedValue([
      {
        id: 'job-1',
        status: 'COMPLETED',
        audience: 'ALL',
        title: 'Hello',
        totalRecipients: 2,
        sentCount: 2,
        failedCount: 0,
        createdById: 'admin-1',
        createdAt: new Date('2026-10-02T00:00:00Z'),
        completedAt: new Date('2026-10-02T00:01:00Z'),
      },
    ] as never);

    const res = fakeRes();
    const next = vi.fn();
    await listBroadcastHistoryHandler(fakeReq({ query: { page: '1', limit: '5' } }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      ok: true,
      data: expect.objectContaining({ total: 1, page: 1, limit: 5 }),
    });
  });

  it('GET /:id returns { job, counts } with counts from the groupBy', async () => {
    broadcastJobFindUnique.mockResolvedValue({ id: 'job-1', sentCount: 1 });
    broadcastRecipientGroupBy.mockResolvedValue([{ status: 'SENT', _count: { _all: 3 } }]);

    const res = fakeRes();
    const next = vi.fn();
    await getBroadcastJobHandler(fakeReq({ params: { id: 'job-1' } }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      ok: true,
      data: { job: expect.objectContaining({ id: 'job-1' }), counts: expect.objectContaining({ sent: 3 }) },
    });
  });

  it('GET /:id answers 404 for an unknown job via next(err)', async () => {
    broadcastJobFindUnique.mockResolvedValue(null);

    const res = fakeRes();
    const next = vi.fn();
    await getBroadcastJobHandler(fakeReq({ params: { id: 'missing' } }), res, next);

    expect(res.body).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]![0]).toMatchObject({ statusCode: 404 });
  });

  it('GET /:id/recipients applies the status filter and stringifies a BigInt message id', async () => {
    broadcastJobFindUnique.mockResolvedValue({ id: 'job-1' });
    broadcastRecipientCount.mockResolvedValue(1);
    broadcastRecipientFindMany.mockResolvedValue([
      {
        id: 'rec-1',
        userId: 'u1',
        status: 'SENT',
        telegramMessageId: 740000000000000123n,
        error: null,
        sentAt: new Date('2026-10-02T00:00:00Z'),
        createdAt: new Date('2026-10-02T00:00:00Z'),
        user: { firstName: null, lastName: null, username: 'zed' },
      },
    ] as never);

    const res = fakeRes();
    const next = vi.fn();
    await listBroadcastRecipientsHandler(
      fakeReq({ params: { id: 'job-1' }, query: { status: 'SENT', page: '1', limit: '20' } }),
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    const findArgs = broadcastRecipientFindMany.mock.calls[0]![0] as { where: { status?: string } };
    expect(findArgs.where.status).toBe('SENT');
    const data = (res.body as { data: { items: { telegramMessageId: unknown; userName: string }[] } }).data;
    // jsonSafe turns the BigInt into a decimal string — never a lossy number.
    expect(data.items[0]!.telegramMessageId).toBe('740000000000000123');
    expect(data.items[0]!.userName).toBe('@zed');
  });

  it('GET /:id/recipients answers 404 for an unknown job', async () => {
    broadcastJobFindUnique.mockResolvedValue(null);
    const res = fakeRes();
    const next = vi.fn();
    await listBroadcastRecipientsHandler(fakeReq({ params: { id: 'missing' } }), res, next);
    expect(next.mock.calls[0]![0]).toMatchObject({ statusCode: 404 });
  });
});

/* ------------------------------------------------------------------ */
/* the non-broadcast path is untouched                                 */
/* ------------------------------------------------------------------ */

describe('notification payload shape', () => {
  it('a NON-broadcast notification is enqueued WITHOUT any tracking ids', async () => {
    notificationCreateMany.mockResolvedValue({});

    await createBulkNotifications([
      { userId: 'u1', type: 'SYSTEM' as never, title: 't', body: 'b' },
    ]);

    expect(enqueueNotificationStrict).toHaveBeenCalledTimes(1);
    const payload = enqueueNotificationStrict.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toEqual({ userId: 'u1', type: 'SYSTEM', title: 't', body: 'b', data: undefined });
    expect('broadcastJobId' in payload).toBe(false);
    expect('broadcastRecipientId' in payload).toBe(false);
  });

  it('a broadcast fan-out adds the tracking ids to the payload', async () => {
    notificationCreateMany.mockResolvedValue({});

    await createBulkNotifications([
      {
        userId: 'u1',
        type: 'SYSTEM' as never,
        title: 't',
        body: 'b',
        broadcastJobId: 'job-1',
        broadcastRecipientId: 'rec-1',
      },
    ]);

    expect(enqueueNotificationStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        broadcastJobId: 'job-1',
        broadcastRecipientId: 'rec-1',
      }),
    );
  });
});

describe('classifyUserMessageResult', () => {
  it('maps a successful send to SENT with the message id', () => {
    expect(
      classifyUserMessageResult({ ok: true, messageId: 42n, error: null, permanent: false }),
    ).toEqual({ status: 'SENT', telegramMessageId: 42n, error: null });
  });

  it('maps a permanent refusal to SKIPPED', () => {
    expect(
      classifyUserMessageResult({
        ok: false,
        messageId: null,
        error: '403: Forbidden: bot was blocked by the user',
        permanent: true,
      }),
    ).toEqual({
      status: 'SKIPPED',
      telegramMessageId: null,
      error: '403: Forbidden: bot was blocked by the user',
    });
  });

  it('maps a transient failure to FAILED', () => {
    expect(
      classifyUserMessageResult({ ok: false, messageId: null, error: 'timeout', permanent: false }),
    ).toEqual({ status: 'FAILED', telegramMessageId: null, error: 'timeout' });
  });
});

/**
 * The row is the notification; the push is its delivery.
 *
 * A bulk fan-out used to queue the Telegram pushes even when the rows could not be
 * stored, which produced a user who received a message the panel's history had no record
 * of — the one state that cannot be reconciled afterwards. And a broadcast recipient whose
 * push was never queued is not "pending": it is undelivered, and the job would otherwise
 * wait for it for ever.
 */
describe('a fan-out that could not be stored', () => {
  it('queues nothing', async () => {
    notificationCreateMany.mockRejectedValue(new Error('database unavailable'));

    await createBulkNotifications([
      { userId: 'u1', type: 'SYSTEM' as never, title: 't', body: 'b' },
      { userId: 'u2', type: 'SYSTEM' as never, title: 't', body: 'b' },
    ]);

    expect(enqueueNotificationStrict).not.toHaveBeenCalled();
  });

  it('records a tracked recipient as FAILED rather than leaving it pending', async () => {
    notificationCreateMany.mockRejectedValue(new Error('database unavailable'));
    broadcastRecipientUpdate.mockResolvedValue({});
    broadcastRecipientGroupBy.mockResolvedValue([
      { status: 'FAILED', _count: { _all: 1 } },
    ]);
    broadcastJobUpdate.mockResolvedValue({});

    await createBulkNotifications([
      {
        userId: 'u1',
        type: 'SYSTEM' as never,
        title: 't',
        body: 'b',
        broadcastJobId: 'job-1',
        broadcastRecipientId: 'rec-1',
      },
    ]);

    expect(broadcastRecipientUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rec-1' },
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
    expect(enqueueNotificationStrict).not.toHaveBeenCalled();
  });
});

/**
 * One push, one notification.
 *
 * Marking the row as delivered used to be an `updateMany` filtered on
 * (user, type, title, body, undelivered), so two identical notifications of the same type
 * were both marked delivered as soon as one push succeeded — the second was reported as
 * delivered while its own push was still queued, or never queued at all.
 */
describe('marking a notification delivered', () => {
  it('updates exactly one row, chosen by id and oldest first', async () => {
    userFindUnique.mockResolvedValue({ telegramId: 4242n });
    notificationFindFirst.mockResolvedValue({ id: 'n_1' });
    notificationUpdate.mockResolvedValue({});

    const ok = await deliverToTelegram({
      userId: 'u1',
      type: 'SYSTEM',
      title: 'Maintenance',
      body: 'Window 02:00-03:00',
    });

    expect(ok).toBe(true);
    expect(notificationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'u1',
          type: 'SYSTEM',
          title: 'Maintenance',
          body: 'Window 02:00-03:00',
          delivered: false,
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(notificationUpdate).toHaveBeenCalledWith({
      where: { id: 'n_1' },
      data: expect.objectContaining({ delivered: true }),
    });
    // The bulk update that could touch unrelated twins is gone.
    expect(notificationUpdateMany).not.toHaveBeenCalled();
  });

  it('delivers without a row to mark, rather than failing the push', async () => {
    userFindUnique.mockResolvedValue({ telegramId: 4242n });
    notificationFindFirst.mockResolvedValue(null);

    expect(
      await deliverToTelegram({ userId: 'u1', type: 'SYSTEM', title: 't', body: 'b' }),
    ).toBe(true);
    expect(notificationUpdate).not.toHaveBeenCalled();
  });
});

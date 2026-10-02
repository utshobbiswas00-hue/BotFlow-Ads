import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

/**
 * DB-FREE unit tests for the admin notification inbox handlers.
 *
 * The inbox is the SEPARATE `AdminNotification` table keyed on the acting
 * admin's `AdminUser` id (`req.admin.id`), so these tests mock Prisma and drive
 * the four handlers directly. No PostgreSQL, no Redis, no network:
 * `notifications.routes.ts` pulls in the notification service, which in turn
 * imports the queue producers / Telegram / mailer modules at load time, so all
 * of those are mocked too.
 *
 * The user-scoped `Notification` delegate is ALSO mocked: if a handler ever
 * reached for it, the mocked-`AdminNotification` assertions below would fail.
 */

vi.mock('../../../db/prisma', () => ({
  prisma: {
    notification: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    adminNotification: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  transaction: vi.fn(),
}));

vi.mock('../../../queues/producers', () => ({
  enqueueNotification: vi.fn(async () => undefined),
}));

vi.mock('../../../utils/telegram', () => ({
  sendUserMessage: vi.fn(async () => true),
  sendUserMessageDetailed: vi.fn(async () => ({
    ok: true,
    messageId: 1n,
    error: null,
    permanent: false,
  })),
}));

vi.mock('../../../utils/mailer', () => ({
  notificationEmailHtml: vi.fn(() => ''),
  sendMail: vi.fn(async () => undefined),
}));

vi.mock('../../../services/email.service', () => ({
  sendTransactionalEmail: vi.fn(async () => undefined),
}));

import { prisma } from '../../../db/prisma';
import { NotFoundError } from '../../../utils/errors';
import {
  adminUnreadCountHandler,
  listAdminNotificationsHandler,
  markAdminNotificationReadHandler,
  markAllAdminNotificationsReadHandler,
} from '../notifications.routes';

const ACTING_ADMIN = 'admin-acting';

/** A `res` that records the single `res.json({ ok, data })` envelope. */
function mockRes() {
  const res = {} as {
    statusCode: number;
    body: unknown;
    json: (v: unknown) => void;
  };
  res.json = vi.fn((v: unknown) => {
    res.body = v;
  });
  return res;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    admin: { id: ACTING_ADMIN, role: 'MODERATOR', permissions: [] },
    query: {},
    params: {},
    ...overrides,
  } as unknown as Request;
}

/** The `data` half of the `{ ok: true, data }` envelope. */
function dataOf(res: ReturnType<typeof mockRes>): Record<string, unknown> {
  return (res.body as { ok: boolean; data: Record<string, unknown> }).data;
}

const adminCount = vi.mocked(prisma.adminNotification.count);
const adminFindMany = vi.mocked(prisma.adminNotification.findMany);
const adminFindFirst = vi.mocked(prisma.adminNotification.findFirst);
const adminUpdateMany = vi.mocked(prisma.adminNotification.updateMany);

function row(id: string, isRead: boolean) {
  return {
    id,
    type: 'SYSTEM',
    title: `Alert ${id}`,
    body: 'something happened',
    data: { source: 'alertAdmins' },
    link: null,
    isRead,
    readAt: isRead ? new Date('2026-10-01T00:00:00.000Z') : null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET / — list', () => {
  it('returns the frozen AdminNotificationsResult envelope, newest first, with unread', async () => {
    const rows = [row('n2', false), row('n1', true)];
    adminFindMany.mockResolvedValue(rows as never);
    // Call order inside the handler: list total count, then the unread count.
    adminCount.mockResolvedValueOnce(5 as never).mockResolvedValueOnce(2 as never);

    const res = mockRes();
    await listAdminNotificationsHandler(mockReq(), res as unknown as Response, vi.fn());

    const data = dataOf(res);
    expect(Object.keys(data).sort()).toEqual(
      ['hasMore', 'items', 'limit', 'page', 'total', 'unread'].sort(),
    );
    expect(data.items).toEqual(rows);
    expect(data.page).toBe(1);
    expect(data.limit).toBe(20);
    expect(data.total).toBe(5);
    expect(data.hasMore).toBe(true);
    // The count returned WITH the page, not a second, racing source.
    expect(data.unread).toBe(2);

    expect(adminFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { adminId: ACTING_ADMIN },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      }),
    );
    // The admin inbox is backed by AdminNotification — never the user table.
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });

  it('caps an over-large limit at PAGINATION.MAX_LIMIT (100) instead of rejecting it', async () => {
    adminFindMany.mockResolvedValue([] as never);
    adminCount.mockResolvedValue(0 as never);

    const res = mockRes();
    await listAdminNotificationsHandler(
      mockReq({ query: { limit: '1000' } as never }),
      res as unknown as Response,
      vi.fn(),
    );

    expect(dataOf(res).limit).toBe(100);
    expect(adminFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it('honours page via skip = (page - 1) * limit', async () => {
    adminFindMany.mockResolvedValue([] as never);
    adminCount.mockResolvedValue(0 as never);

    const res = mockRes();
    await listAdminNotificationsHandler(
      mockReq({ query: { page: '3', limit: '10' } as never }),
      res as unknown as Response,
      vi.fn(),
    );

    expect(dataOf(res).page).toBe(3);
    expect(adminFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });

  it('unreadOnly=true filters the query AND still counts unread', async () => {
    adminFindMany.mockResolvedValue([row('n1', false)] as never);
    adminCount.mockResolvedValue(1 as never);

    const res = mockRes();
    await listAdminNotificationsHandler(
      mockReq({ query: { unreadOnly: 'true' } as never }),
      res as unknown as Response,
      vi.fn(),
    );

    expect(adminFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { adminId: ACTING_ADMIN, isRead: false } }),
    );
    // list count + unread count, both scoped to the acting admin.
    expect(adminCount).toHaveBeenCalledWith({
      where: { adminId: ACTING_ADMIN, isRead: false },
    });
    expect(dataOf(res).unread).toBe(1);
  });

  it('unreadOnly=false (absent) lists the whole inbox', async () => {
    adminFindMany.mockResolvedValue([] as never);
    adminCount.mockResolvedValue(0 as never);

    const res = mockRes();
    await listAdminNotificationsHandler(mockReq(), res as unknown as Response, vi.fn());

    expect(adminFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { adminId: ACTING_ADMIN } }),
    );
  });

  it('401s when there is no authenticated admin', async () => {
    const next = vi.fn();
    await listAdminNotificationsHandler(
      mockReq({ admin: undefined }),
      mockRes() as unknown as Response,
      next as unknown as NextFunction,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as { statusCode: number }).statusCode).toBe(401);
  });
});

describe('GET /unread-count', () => {
  it('returns the acting admin unread count as { unread }', async () => {
    adminCount.mockResolvedValue(7 as never);

    const res = mockRes();
    await adminUnreadCountHandler(mockReq(), res as unknown as Response, vi.fn());

    expect(dataOf(res)).toEqual({ unread: 7 });
    expect(adminCount).toHaveBeenCalledWith({
      where: { adminId: ACTING_ADMIN, isRead: false },
    });
  });
});

describe('POST /:id/read', () => {
  it('marks an unread row read and returns { id, isRead: true }', async () => {
    adminFindFirst.mockResolvedValue({ id: 'n1', isRead: false } as never);
    adminUpdateMany.mockResolvedValue({ count: 1 } as never);

    const res = mockRes();
    await markAdminNotificationReadHandler(
      mockReq({ params: { id: 'n1' } as never }),
      res as unknown as Response,
      vi.fn(),
    );

    expect(dataOf(res)).toEqual({ id: 'n1', isRead: true });
    expect(adminUpdateMany).toHaveBeenCalledWith({
      where: { adminId: ACTING_ADMIN, id: { in: ['n1'] }, isRead: false },
      data: { isRead: true, readAt: expect.any(Date) },
    });
  });

  it('is idempotent: an already-read row is a no-op 200, not an error', async () => {
    adminFindFirst.mockResolvedValue({ id: 'n1', isRead: true } as never);

    const res = mockRes();
    const next = vi.fn();
    await markAdminNotificationReadHandler(
      mockReq({ params: { id: 'n1' } as never }),
      res as unknown as Response,
      next as unknown as NextFunction,
    );

    expect(dataOf(res)).toEqual({ id: 'n1', isRead: true });
    expect(adminUpdateMany).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('404s (not 403) when the id does not belong to the acting admin', async () => {
    // findFirst is scoped { id, adminId }, so another admin's row matches nothing.
    adminFindFirst.mockResolvedValue(null as never);

    const next = vi.fn();
    await markAdminNotificationReadHandler(
      mockReq({ params: { id: 'someone-elses-row' } as never }),
      mockRes() as unknown as Response,
      next as unknown as NextFunction,
    );

    expect(adminFindFirst).toHaveBeenCalledWith({
      where: { id: 'someone-elses-row', adminId: ACTING_ADMIN },
      select: { id: true, isRead: true },
    });
    expect(adminUpdateMany).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0] as NotFoundError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.statusCode).toBe(404);
  });
});

describe('POST /read-all', () => {
  it('marks every unread row for the acting admin and returns { updated }', async () => {
    adminUpdateMany.mockResolvedValue({ count: 4 } as never);

    const res = mockRes();
    await markAllAdminNotificationsReadHandler(mockReq(), res as unknown as Response, vi.fn());

    expect(dataOf(res)).toEqual({ updated: 4 });
    expect(adminUpdateMany).toHaveBeenCalledWith({
      where: { adminId: ACTING_ADMIN, isRead: false },
      data: { isRead: true, readAt: expect.any(Date) },
    });
  });
});

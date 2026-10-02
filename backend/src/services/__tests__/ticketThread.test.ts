import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-FREE unit tests for the admin-scoped ticket thread read (§50).
 *
 * The whole point of the change: `getTicket(userId, ticketId)` calls
 * `assertTicketOwner`, so an admin reading someone else's ticket gets a
 * ForbiddenError. `getTicketAdmin(ticketId)` is the same query minus that
 * assertion — authorisation moves to the route's `tickets.view` permission.
 *
 * Prisma and the audit service are mocked; no PostgreSQL is touched. Follows the
 * mocking style of `services/__tests__/userModeration.test.ts`.
 */
vi.mock('../../db/prisma', () => ({
  prisma: {
    supportTicket: { findUnique: vi.fn() },
    ticketMessage: { findMany: vi.fn() },
  },
  transaction: vi.fn(),
}));

// `ticket.service` -> `premium.service` -> `settings.service` pulls Redis in at
// import time; it is never exercised here, so it is mocked rather than dialled.
vi.mock('../../db/redis', () => ({
  redis: {},
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  createQueueConnection: vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn() })),
}));

vi.mock('../../queues/queue', () => ({}));

vi.mock('../audit.service', () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock('../transaction.service', () => ({
  postLedger: vi.fn(),
}));

import { prisma } from '../../db/prisma';
import { ForbiddenError, NotFoundError } from '../../utils/errors';
import { getTicket, getTicketAdmin } from '../ticket.service';

const ticketFindUnique = vi.mocked(prisma.supportTicket.findUnique);
const messageFindMany = vi.mocked(prisma.ticketMessage.findMany);

const TICKET = {
  id: 't1',
  ticketNo: 'BF-20261001-00001',
  subject: 'Cannot log in',
  category: 'general',
  status: 'OPEN',
  priority: 'NORMAL',
  assignedToId: null,
  lastMessageAt: new Date('2026-10-01T10:05:00.000Z'),
  closedAt: null,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  updatedAt: new Date('2026-10-01T10:05:00.000Z'),
};

const MESSAGES = [
  {
    id: 'm1',
    senderId: 'owner-1',
    senderType: 'USER',
    body: 'I cannot log in.',
    attachmentUrl: null,
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
  },
  {
    id: 'm2',
    senderId: null,
    senderType: 'ADMIN',
    body: 'Reset link sent.',
    attachmentUrl: 'https://cdn.example.com/screenshot.png',
    createdAt: new Date('2026-10-01T10:05:00.000Z'),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getTicketAdmin — admin-scoped thread read', () => {
  it('returns the ticket and its messages, oldest first', async () => {
    ticketFindUnique.mockResolvedValue(TICKET as never);
    messageFindMany.mockResolvedValue(MESSAGES as never);

    const result = await getTicketAdmin('t1');

    expect(result.ticket).toEqual(TICKET);
    expect(result.messages).toEqual(MESSAGES);
    // Same query as getTicket minus the ownership assertion, ordered as getTicket
    // orders it.
    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ticketId: 't1' },
        orderBy: { createdAt: 'asc' },
      }),
    );
  });

  it('404s for a ticket that does not exist', async () => {
    ticketFindUnique.mockResolvedValue(null as never);
    messageFindMany.mockResolvedValue([] as never);

    await expect(getTicketAdmin('ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lets an admin read a ticket whose owner is someone else — the whole point', async () => {
    // The ticket belongs to `owner-1`; getTicketAdmin has no userId to compare
    // against, so the read must succeed rather than 403.
    ticketFindUnique.mockResolvedValue({ ...TICKET, userId: 'owner-1' } as never);
    messageFindMany.mockResolvedValue(MESSAGES as never);

    await expect(getTicketAdmin('t1')).resolves.toMatchObject({ ticket: { id: 't1' } });
  });

  it('the owner path still rejects a non-owner (regression guard)', async () => {
    ticketFindUnique.mockResolvedValue({ id: 't1', userId: 'owner-1', status: 'OPEN' } as never);

    await expect(getTicket('admin-1', 't1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(messageFindMany).not.toHaveBeenCalled();
  });
});

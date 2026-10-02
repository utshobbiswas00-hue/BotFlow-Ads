import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-FREE unit tests for the admin list §79 date-range + sort support.
 *
 * The security-relevant part is the sort-key → Prisma `orderBy` mapping: a
 * client-supplied `sort` string must never reach the query builder. Every
 * endpoint exposes a mapper that is a switch over a typed union, so only the
 * whitelisted keys can produce an `orderBy` — an unlisted value is a
 * compile-time error, not an injection.
 *
 * Follows the mocking style of `services/__tests__/userModeration.test.ts`:
 * Prisma and the Redis/queue clients are mocked, so no PostgreSQL or Redis is
 * touched (importing the services must not open a real connection).
 */
vi.mock('../../db/prisma', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/prisma')>();
  return {
    ...actual,
    prisma: {
      deposit: { count: vi.fn(), findMany: vi.fn() },
      withdrawal: { count: vi.fn(), findMany: vi.fn() },
      campaign: { count: vi.fn(), findMany: vi.fn() },
      channel: { count: vi.fn(), findMany: vi.fn() },
      deliveryJob: { count: vi.fn(), findMany: vi.fn() },
      user: { count: vi.fn(), findMany: vi.fn() },
    },
    transaction: vi.fn(),
  };
});

vi.mock('../../db/redis', () => ({
  redis: {},
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  createQueueConnection: vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn() })),
}));

vi.mock('../../queues/queue', () => ({}));

import { prisma } from '../../db/prisma';
import { getPagination } from '../../utils/pagination';
import { depositOrderBy, listDepositsAdmin } from '../deposit.service';
import { withdrawalOrderBy } from '../withdrawal.service';
import {
  campaignOrderBy,
  channelOrderBy,
  deliveryJobOrderBy,
  listCampaignsAdmin,
  userOrderBy,
} from '../admin.service';

const depositCount = vi.mocked(prisma.deposit.count);
const depositFindMany = vi.mocked(prisma.deposit.findMany);
const campaignCount = vi.mocked(prisma.campaign.count);
const campaignFindMany = vi.mocked(prisma.campaign.findMany);

beforeEach(() => {
  vi.clearAllMocks();
  depositCount.mockResolvedValue(0);
  depositFindMany.mockResolvedValue([] as never);
  campaignCount.mockResolvedValue(0);
  campaignFindMany.mockResolvedValue([] as never);
});

/* ------------------------------------------------------------------
 *  Sort-key → orderBy mapping (the injection-sensitive part)
 * ------------------------------------------------------------------ */

describe('depositOrderBy — deposits list sort whitelist', () => {
  it.each([
    ['created_at', { createdAt: 'asc' }],
    ['created_at_desc', { createdAt: 'desc' }],
    ['amount', { amountCents: 'asc' }],
    ['amount_desc', { amountCents: 'desc' }],
  ] as const)('maps %s to an explicit orderBy', (key, expected) => {
    expect(depositOrderBy(key)).toEqual(expected);
  });
});

describe('withdrawalOrderBy — withdrawals list sort whitelist', () => {
  it.each([
    ['created_at', { createdAt: 'asc' }],
    ['created_at_desc', { createdAt: 'desc' }],
    ['amount', { amountCents: 'asc' }],
    ['amount_desc', { amountCents: 'desc' }],
  ] as const)('maps %s to an explicit orderBy', (key, expected) => {
    expect(withdrawalOrderBy(key)).toEqual(expected);
  });
});

describe('campaignOrderBy — campaigns list sort whitelist', () => {
  it.each([
    ['created_at', { createdAt: 'asc' }],
    ['created_at_desc', { createdAt: 'desc' }],
    ['updated_at', { updatedAt: 'asc' }],
    ['updated_at_desc', { updatedAt: 'desc' }],
  ] as const)('maps %s to an explicit orderBy', (key, expected) => {
    expect(campaignOrderBy(key)).toEqual(expected);
  });
});

describe('channelOrderBy — channels list sort whitelist', () => {
  it.each([
    ['created_at', { createdAt: 'asc' }],
    ['created_at_desc', { createdAt: 'desc' }],
    ['updated_at', { updatedAt: 'asc' }],
    ['updated_at_desc', { updatedAt: 'desc' }],
  ] as const)('maps %s to an explicit orderBy', (key, expected) => {
    expect(channelOrderBy(key)).toEqual(expected);
  });
});

describe('userOrderBy — users list sort whitelist', () => {
  it.each([
    ['created_at', { createdAt: 'asc' }],
    ['created_at_desc', { createdAt: 'desc' }],
    ['updated_at', { updatedAt: 'asc' }],
    ['updated_at_desc', { updatedAt: 'desc' }],
  ] as const)('maps %s to an explicit orderBy', (key, expected) => {
    expect(userOrderBy(key)).toEqual(expected);
  });
});

describe('deliveryJobOrderBy — delivery list sort whitelist', () => {
  it.each([
    ['scheduled_at', [{ scheduledAt: 'asc' }, { createdAt: 'desc' }]],
    ['scheduled_at_desc', [{ scheduledAt: 'desc' }, { createdAt: 'desc' }]],
    ['created_at', [{ createdAt: 'asc' }]],
    ['created_at_desc', [{ createdAt: 'desc' }]],
  ] as const)('maps %s to an explicit orderBy', (key, expected) => {
    expect(deliveryJobOrderBy(key)).toEqual(expected);
  });
});

/* ------------------------------------------------------------------
 *  Wiring: defaults preserved, filters applied to the right column
 * ------------------------------------------------------------------ */

describe('listDepositsAdmin — §79 filters are backward compatible', () => {
  it('preserves the default newest-first ordering and an empty where when no new params are sent', async () => {
    await listDepositsAdmin({}, getPagination({}));

    expect(depositFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, orderBy: { createdAt: 'desc' } }),
    );
    expect(depositCount).toHaveBeenCalledWith({ where: {} });
  });

  it('maps a whitelisted sort key onto the deposit amount column', async () => {
    await listDepositsAdmin({ sort: 'amount_desc' }, getPagination({}));

    expect(depositFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { amountCents: 'desc' } }),
    );
  });

  it('applies the from/to window to Deposit.createdAt', async () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-02-01T00:00:00.000Z');

    await listDepositsAdmin({ from, to }, getPagination({}));

    expect(depositCount).toHaveBeenCalledWith({ where: { createdAt: { gte: from, lt: to } } });
  });
});

describe('listCampaignsAdmin — §79 filters are backward compatible', () => {
  it('preserves the default newest-first ordering when no sort is sent', async () => {
    await listCampaignsAdmin({ status: 'PENDING_REVIEW' }, getPagination({}));

    expect(campaignFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PENDING_REVIEW' },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('maps a whitelisted sort key onto Campaign.updatedAt', async () => {
    await listCampaignsAdmin({ sort: 'updated_at_desc' }, getPagination({}));

    expect(campaignFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { updatedAt: 'desc' } }),
    );
  });

  it('applies the from/to window to Campaign.createdAt', async () => {
    const from = new Date('2026-01-01T00:00:00.000Z');

    await listCampaignsAdmin({ from }, getPagination({}));

    expect(campaignCount).toHaveBeenCalledWith({ where: { createdAt: { gte: from } } });
  });
});

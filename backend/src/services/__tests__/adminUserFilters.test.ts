import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-FREE unit tests for the admin users list role/status filters (§11, §12).
 *
 * The security- and correctness-relevant part is `userRoleWhere`: the
 * `isPublisher` / `isAdvertiser` filters must be derived from the RELATIONSHIPS
 * (channels / campaigns) rather than the cached boolean columns on `User`,
 * because those cached columns can drift and make the admin list lie.
 *
 * Follows the mocking style of `services/__tests__/userModeration.test.ts` and
 * `adminListSort.test.ts`: Prisma and the Redis/queue clients are mocked, so no
 * PostgreSQL or Redis is touched (importing the service must not connect).
 */
vi.mock('../../db/prisma', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/prisma')>();
  return {
    ...actual,
    prisma: {
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
import { listUsersAdmin, userRoleWhere } from '../admin.service';

const userCount = vi.mocked(prisma.user.count);
const userFindMany = vi.mocked(prisma.user.findMany);

beforeEach(() => {
  vi.clearAllMocks();
  userCount.mockResolvedValue(0);
  userFindMany.mockResolvedValue([] as never);
});

/* ------------------------------------------------------------------
 *  Pure where-clause builder
 * ------------------------------------------------------------------ */

describe('userRoleWhere — role filters come from the relationships, not cached columns', () => {
  it('returns an empty clause when neither role filter is present', () => {
    expect(userRoleWhere({})).toEqual({});
  });

  it('maps isPublisher=true to "has at least one Channel"', () => {
    expect(userRoleWhere({ isPublisher: true })).toEqual({ channels: { some: {} } });
  });

  it('maps isPublisher=false to "has no Channel"', () => {
    expect(userRoleWhere({ isPublisher: false })).toEqual({ channels: { none: {} } });
  });

  it('maps isAdvertiser=true to "has at least one Campaign"', () => {
    expect(userRoleWhere({ isAdvertiser: true })).toEqual({ campaigns: { some: {} } });
  });

  it('maps isAdvertiser=false to "has no Campaign"', () => {
    expect(userRoleWhere({ isAdvertiser: false })).toEqual({ campaigns: { none: {} } });
  });

  it('never filters on the cached isPublisher / isAdvertiser columns', () => {
    const where = userRoleWhere({ isPublisher: true, isAdvertiser: false });
    expect(where).not.toHaveProperty('isPublisher');
    expect(where).not.toHaveProperty('isAdvertiser');
  });

  it('composes both role filters together', () => {
    expect(userRoleWhere({ isPublisher: true, isAdvertiser: true })).toEqual({
      channels: { some: {} },
      campaigns: { some: {} },
    });
  });

  it('leaves a filter out entirely when it is undefined', () => {
    expect(userRoleWhere({ isPublisher: true })).not.toHaveProperty('campaigns');
  });
});

/* ------------------------------------------------------------------
 *  Wiring: filters compose with status / date / sort
 * ------------------------------------------------------------------ */

describe('listUsersAdmin — filters compose into one where-clause', () => {
  it('applies status + both role filters to the same query', async () => {
    await listUsersAdmin(undefined, getPagination({}), {
      status: 'ACTIVE',
      isPublisher: true,
      isAdvertiser: false,
    });

    const where = {
      status: 'ACTIVE',
      channels: { some: {} },
      campaigns: { none: {} },
    };
    expect(userCount).toHaveBeenCalledWith({ where });
    expect(userFindMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
  });

  it('keeps the default empty where when no filter is given', async () => {
    await listUsersAdmin(undefined, getPagination({}));

    expect(userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, orderBy: { createdAt: 'desc' } }),
    );
  });

  it('ANDs the role filters with the date window', async () => {
    const from = new Date('2026-01-01T00:00:00.000Z');

    await listUsersAdmin(undefined, getPagination({}), { from, isPublisher: true });

    expect(userCount).toHaveBeenCalledWith({
      where: { createdAt: { gte: from }, channels: { some: {} } },
    });
  });
});

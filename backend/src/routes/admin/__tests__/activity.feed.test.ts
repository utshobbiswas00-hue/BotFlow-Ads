import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-FREE unit tests for the computed activity stream (spec §65).
 *
 * Every Prisma model the feed reads is mocked, so nothing connects. The two
 * behaviours that matter are pinned: the merged output is newest-first, and a
 * single failing source is swallowed rather than blanking the whole feed.
 */
vi.mock('../../../db/prisma', () => ({
  prisma: {
    user: { findMany: vi.fn() },
    channel: { findMany: vi.fn() },
    campaign: { findMany: vi.fn() },
    adPost: { findMany: vi.fn() },
    deposit: { findMany: vi.fn() },
    withdrawal: { findMany: vi.fn() },
    report: { findMany: vi.fn() },
    fraudEvent: { findMany: vi.fn() },
  },
  transaction: vi.fn(),
}));

import { prisma } from '../../../db/prisma';
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  buildActivityFeed,
  mergeActivityItems,
  parseActivityLimit,
  type ActivityItem,
} from '../activity.routes';

const user = vi.mocked(prisma.user.findMany);
const channel = vi.mocked(prisma.channel.findMany);
const campaign = vi.mocked(prisma.campaign.findMany);
const adPost = vi.mocked(prisma.adPost.findMany);
const deposit = vi.mocked(prisma.deposit.findMany);
const withdrawal = vi.mocked(prisma.withdrawal.findMany);
const report = vi.mocked(prisma.report.findMany);
const fraudEvent = vi.mocked(prisma.fraudEvent.findMany);

const at = (iso: string) => new Date(iso);

beforeEach(() => {
  vi.clearAllMocks();
  user.mockResolvedValue([] as never);
  channel.mockResolvedValue([] as never);
  campaign.mockResolvedValue([] as never);
  adPost.mockResolvedValue([] as never);
  deposit.mockResolvedValue([] as never);
  withdrawal.mockResolvedValue([] as never);
  report.mockResolvedValue([] as never);
  fraudEvent.mockResolvedValue([] as never);
});

describe('buildActivityFeed — newest-first merge across sources', () => {
  it('merges rows from several tables and orders them by createdAt desc', async () => {
    user.mockResolvedValue([
      { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', username: 'ada', createdAt: at('2026-01-01T09:00:00.000Z') },
    ] as never);
    deposit.mockResolvedValue([
      { id: 'd1', amountCents: 5000, currency: 'USD', method: 'crypto', status: 'VERIFIED', createdAt: at('2026-01-01T11:00:00.000Z') },
    ] as never);
    fraudEvent.mockResolvedValue([
      { id: 'f1', type: 'CLICK_FLOOD', severity: 'HIGH', resolved: false, createdAt: at('2026-01-01T10:00:00.000Z') },
    ] as never);

    const items = await buildActivityFeed(60);

    expect(items.map((i) => i.id)).toEqual(['d1', 'f1', 'u1']);
    expect(items.map((i) => i.kind)).toEqual(['DEPOSIT', 'FRAUD_EVENT', 'NEW_USER']);
  });

  it('slices the merged list down to the requested limit', async () => {
    user.mockResolvedValue([
      { id: 'u1', firstName: 'A', lastName: null, username: null, createdAt: at('2026-01-01T03:00:00.000Z') },
      { id: 'u2', firstName: 'B', lastName: null, username: null, createdAt: at('2026-01-01T02:00:00.000Z') },
    ] as never);
    deposit.mockResolvedValue([
      { id: 'd1', amountCents: 100, currency: 'USD', method: 'crypto', status: 'PENDING', createdAt: at('2026-01-01T01:00:00.000Z') },
    ] as never);

    const items = await buildActivityFeed(2);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id)).toEqual(['u1', 'u2']);
  });

  it('survives one rejected source instead of blanking the feed', async () => {
    channel.mockRejectedValue(new Error('channels query exploded'));
    user.mockResolvedValue([
      { id: 'u1', firstName: 'Ada', lastName: null, username: null, createdAt: at('2026-01-01T09:00:00.000Z') },
    ] as never);

    const items = await buildActivityFeed(60);

    expect(items.some((i) => i.kind === 'NEW_USER')).toBe(true);
    // Only the failed source is missing.
    expect(items.some((i) => i.kind === 'NEW_CHANNEL')).toBe(false);
  });

  it('never exposes a telegram id or an email in a label/detail', async () => {
    user.mockResolvedValue([
      {
        id: 'u1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        username: 'ada',
        // Fields that are NOT selected by the route; present only to prove they
        // cannot leak because the mapper never reads them.
        telegramId: 123456789n,
        email: 'ada@example.com',
        createdAt: at('2026-01-01T09:00:00.000Z'),
      },
    ] as never);

    const items = await buildActivityFeed(60);
    const serialised = JSON.stringify(items);
    expect(serialised).not.toContain('123456789');
    expect(serialised).not.toContain('ada@example.com');
    expect(items[0].href).toBe('/admin/users/u1');
  });
});

describe('mergeActivityItems / parseActivityLimit', () => {
  it('sorts descending and respects the limit', () => {
    const items: ActivityItem[] = [
      { kind: 'A', id: 'a', label: 'a', detail: null, href: null, createdAt: '2026-01-01T01:00:00.000Z' },
      { kind: 'B', id: 'b', label: 'b', detail: null, href: null, createdAt: '2026-01-01T03:00:00.000Z' },
      { kind: 'C', id: 'c', label: 'c', detail: null, href: null, createdAt: '2026-01-01T02:00:00.000Z' },
    ];
    expect(mergeActivityItems(items, 2).map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('defaults to 60 and caps at 200', () => {
    expect(parseActivityLimit(undefined)).toBe(ACTIVITY_DEFAULT_LIMIT);
    expect(parseActivityLimit('')).toBe(ACTIVITY_DEFAULT_LIMIT);
    expect(parseActivityLimit('999')).toBe(ACTIVITY_MAX_LIMIT);
    expect(parseActivityLimit('150')).toBe(150);
    expect(parseActivityLimit('0')).toBe(1);
  });
});

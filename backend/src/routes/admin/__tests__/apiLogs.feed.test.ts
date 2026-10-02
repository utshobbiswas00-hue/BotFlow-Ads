import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-FREE unit tests for the integration failure view (spec §27).
 *
 * Prisma is mocked. The tests pin the two behaviours that could silently break:
 * all three sources are merged and newest-first, and a `source` filter narrows
 * the merged set instead of being ignored.
 */
vi.mock('../../../db/prisma', () => ({
  prisma: {
    errorLog: { count: vi.fn(), findMany: vi.fn() },
    deliveryEvent: { count: vi.fn(), findMany: vi.fn() },
    webhookDelivery: { count: vi.fn(), findMany: vi.fn() },
  },
  transaction: vi.fn(),
}));

import { prisma } from '../../../db/prisma';
import { getPagination } from '../../../utils/pagination';
import { buildApiLogs } from '../apiLogs.routes';

const errorCount = vi.mocked(prisma.errorLog.count);
const errorFind = vi.mocked(prisma.errorLog.findMany);
const deliveryCount = vi.mocked(prisma.deliveryEvent.count);
const deliveryFind = vi.mocked(prisma.deliveryEvent.findMany);
const webhookCount = vi.mocked(prisma.webhookDelivery.count);
const webhookFind = vi.mocked(prisma.webhookDelivery.findMany);

const at = (iso: string) => new Date(iso);

beforeEach(() => {
  vi.clearAllMocks();
  errorCount.mockResolvedValue(1);
  errorFind.mockResolvedValue([
    {
      id: 'e1',
      source: 'PAYMENT',
      level: 'ERROR',
      code: 'PAYMENT_DUPLICATE',
      message: 'gateway rejected the charge',
      context: 'POST /api/payments',
      createdAt: at('2026-01-01T12:00:00.000Z'),
    },
  ] as never);
  deliveryCount.mockResolvedValue(1);
  deliveryFind.mockResolvedValue([
    {
      id: 't1',
      deliveryJobId: 'job-1',
      message: 'bot is not admin',
      errorCode: 'BOT_NOT_ADMIN',
      createdAt: at('2026-01-01T11:00:00.000Z'),
    },
  ] as never);
  webhookCount.mockResolvedValue(1);
  webhookFind.mockResolvedValue([
    {
      id: 'w1',
      event: 'POST_FAILED',
      responseStatus: 502,
      error: 'endpoint returned 502',
      createdAt: at('2026-01-01T13:00:00.000Z'),
    },
  ] as never);
});

describe('buildApiLogs — merges all three sources', () => {
  it('normalises error_logs, delivery_events and webhook_deliveries, newest-first', async () => {
    const result = await buildApiLogs({}, getPagination({ page: 1, limit: 20 }));

    expect(result.total).toBe(3);
    expect(result.items.map((i) => i.id)).toEqual(['w1', 'e1', 't1']);
    expect(result.items.map((i) => i.source)).toEqual(['WEBHOOK', 'PAYMENT', 'TELEGRAM']);
    expect(result).toMatchObject({ page: 1, limit: 20, hasMore: false });

    const webhook = result.items[0];
    expect(webhook).toMatchObject({ level: 'ERROR', code: '502', message: 'endpoint returned 502' });

    const telegram = result.items[2];
    expect(telegram).toMatchObject({
      level: 'ERROR',
      code: 'BOT_NOT_ADMIN',
      message: 'bot is not admin',
      context: 'delivery:job-1',
    });
  });

  it('restricts error_logs to the three integration sources when no filter is given', async () => {
    await buildApiLogs({}, getPagination({}));
    expect(errorFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { source: { in: ['TELEGRAM', 'PAYMENT', 'WEBHOOK'] } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('paginates the merged set using the requested page window', async () => {
    // error rows = 2, delivery = 1, webhook = 1 → global newest order: e2, e1, t1, w1
    errorCount.mockResolvedValue(2);
    errorFind.mockResolvedValue([
      { id: 'e2', source: 'TELEGRAM', level: 'ERROR', code: null, message: 'm2', context: null, createdAt: at('2026-01-01T13:00:00.000Z') },
      { id: 'e1', source: 'TELEGRAM', level: 'ERROR', code: null, message: 'm1', context: null, createdAt: at('2026-01-01T12:00:00.000Z') },
    ] as never);
    deliveryFind.mockResolvedValue([
      { id: 't1', deliveryJobId: 'job-1', message: 'm', errorCode: 'TELEGRAM_API_ERROR', createdAt: at('2026-01-01T11:00:00.000Z') },
    ] as never);
    webhookFind.mockResolvedValue([
      { id: 'w1', event: 'POST_FAILED', responseStatus: 500, error: 'e', createdAt: at('2026-01-01T10:00:00.000Z') },
    ] as never);

    const page2 = await buildApiLogs({}, getPagination({ page: 2, limit: 2 }));
    expect(page2.total).toBe(4);
    expect(page2.items.map((i) => i.id)).toEqual(['t1', 'w1']);
    expect(page2.hasMore).toBe(false);
  });
});

describe('buildApiLogs — source filter narrows the merged set', () => {
  it('when filtered to TELEGRAM, includes delivery_events and excludes webhooks', async () => {
    const result = await buildApiLogs({ source: 'TELEGRAM' }, getPagination({}));

    expect(errorFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { source: { in: ['TELEGRAM'] } } }),
    );
    // Only the delivery_events source is TELEGRAM here; error_logs returned a
    // PAYMENT row (mocked) which a real query would not, so assert on the webhook
    // exclusion and the delivery inclusion instead of the exact item list.
    expect(deliveryFind).toHaveBeenCalledTimes(1);
    expect(webhookFind).not.toHaveBeenCalled();
    expect(webhookCount).not.toHaveBeenCalled();
    expect(result.items.some((i) => i.source === 'WEBHOOK')).toBe(false);
  });

  it('when filtered to WEBHOOK, includes webhook_deliveries and excludes delivery_events', async () => {
    webhookFind.mockResolvedValue([
      { id: 'w1', event: 'POST_FAILED', responseStatus: 500, error: 'e', createdAt: at('2026-01-01T13:00:00.000Z') },
    ] as never);

    await buildApiLogs({ source: 'WEBHOOK' }, getPagination({}));

    expect(errorFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { source: { in: ['WEBHOOK'] } } }),
    );
    expect(webhookFind).toHaveBeenCalledTimes(1);
    expect(deliveryFind).not.toHaveBeenCalled();
  });

  it('an unknown source yields no rows rather than leaking other error_logs sources', async () => {
    errorCount.mockResolvedValue(0);
    errorFind.mockResolvedValue([] as never);

    const result = await buildApiLogs({ source: 'HTTP' }, getPagination({}));

    expect(errorFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { source: { in: [] } } }),
    );
    expect(deliveryFind).not.toHaveBeenCalled();
    expect(webhookFind).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});

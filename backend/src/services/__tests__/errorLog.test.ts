import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-FREE unit tests for the persisted-error service (spec §84).
 *
 * Prisma is mocked, so nothing connects. Two guarantees are pinned:
 *  1. `recordError` never throws, and it truncates / sanitises what it stores.
 *  2. `listErrorLogs` applies the filters and the standard 5-key pagination.
 */
vi.mock('../../db/prisma', () => ({
  prisma: {
    errorLog: { create: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  },
  transaction: vi.fn(),
}));

import { prisma } from '../../db/prisma';
import { getPagination } from '../../utils/pagination';
import {
  MAX_ERROR_CONTEXT_CHARS,
  MAX_ERROR_MESSAGE_CHARS,
  listErrorLogs,
  recordError,
  sanitizeErrorContext,
  type RecordErrorInput,
} from '../errorLog.service';

const create = vi.mocked(prisma.errorLog.create);
const count = vi.mocked(prisma.errorLog.count);
const findMany = vi.mocked(prisma.errorLog.findMany);

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({} as never);
  count.mockResolvedValue(0);
  findMany.mockResolvedValue([] as never);
});

describe('recordError — truncation and context sanitation', () => {
  it('caps the message and the context at their documented lengths', async () => {
    await recordError({
      source: 'HTTP',
      message: 'x'.repeat(MAX_ERROR_MESSAGE_CHARS + 500),
      context: `GET /api/thing?token=super-secret&email=a@b.com${'y'.repeat(600)}`,
    });

    const data = create.mock.calls[0][0].data as { message: string; context: string };
    expect(data.message).toHaveLength(MAX_ERROR_MESSAGE_CHARS);
    expect(data.context.length).toBeLessThanOrEqual(MAX_ERROR_CONTEXT_CHARS);
  });

  it('never stores a query string (token, email) — only the route part survives', async () => {
    await recordError({
      source: 'HTTP',
      message: 'boom',
      context: 'POST /api/admin/users?reset=abc123&email=victim@example.com',
    });

    const data = create.mock.calls[0][0].data as { context: string };
    expect(data.context).toBe('POST /api/admin/users');
    expect(data.context).not.toContain('?');
    expect(data.context).not.toContain('abc123');
  });

  it('stores ONLY known fields, even if a caller passes headers/cookies/body/query', async () => {
    const leaky = {
      source: 'HTTP',
      message: 'boom',
      context: 'GET /x',
      headers: { authorization: 'Bearer topsecret' },
      cookies: 'session=deadbeef',
      body: { password: 'hunter2' },
      query: '?token=zzz',
    } as unknown as RecordErrorInput;

    await recordError(leaky);

    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      ['code', 'context', 'level', 'message', 'requestId', 'source', 'userId'].sort(),
    );
    const serialised = JSON.stringify(data);
    expect(serialised).not.toContain('topsecret');
    expect(serialised).not.toContain('deadbeef');
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('zzz');
  });

  it('defaults level to ERROR and leaves absent optional fields null', async () => {
    await recordError({ source: 'WORKER', message: 'job failed' });
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.level).toBe('ERROR');
    expect(data.code).toBeNull();
    expect(data.context).toBeNull();
    expect(data.requestId).toBeNull();
    expect(data.userId).toBeNull();
  });
});

describe('recordError — never throws', () => {
  it('resolves false (and does not reject) when the write fails', async () => {
    create.mockRejectedValue(new Error('database is down'));

    await expect(recordError({ source: 'HTTP', message: 'the real error' })).resolves.toBe(false);
  });
});

describe('sanitizeErrorContext', () => {
  it('is null for null/undefined, and cuts at the first ?', () => {
    expect(sanitizeErrorContext(null)).toBeNull();
    expect(sanitizeErrorContext(undefined)).toBeNull();
    expect(sanitizeErrorContext('GET /a/b?x=1&y=2')).toBe('GET /a/b');
    expect(sanitizeErrorContext('GET /a/b')).toBe('GET /a/b');
  });
});

describe('listErrorLogs — filters + pagination', () => {
  it('builds a source/level/date where clause and paginates with the shared helper', async () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-02-01T00:00:00.000Z');
    count.mockResolvedValue(3);
    findMany.mockResolvedValue([
      { id: 'e1', level: 'ERROR', source: 'TELEGRAM', code: 'P2002', message: 'm', context: null, requestId: null, userId: null, createdAt: from },
    ] as never);

    const page = getPagination({ page: 2, limit: 10 });
    const result = await listErrorLogs({ source: 'TELEGRAM', level: 'ERROR', from, to }, page);

    expect(count).toHaveBeenCalledWith({
      where: { source: 'TELEGRAM', level: 'ERROR', createdAt: { gte: from, lt: to } },
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { source: 'TELEGRAM', level: 'ERROR', createdAt: { gte: from, lt: to } },
        orderBy: { createdAt: 'desc' },
        skip: 10,
        take: 10,
      }),
    );
    expect(result).toMatchObject({ page: 2, limit: 10, total: 3, hasMore: false });
    expect(result.items).toHaveLength(1);
  });

  it('omits every filter when none is supplied', async () => {
    await listErrorLogs({}, getPagination({}));
    expect(count).toHaveBeenCalledWith({ where: {} });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, orderBy: { createdAt: 'desc' }, skip: 0, take: 20 }),
    );
  });
});

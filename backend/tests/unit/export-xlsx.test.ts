import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-FREE test for the .xlsx export route.
 *
 * The handler is invoked directly (via the router's own stack) with a fake
 * Express request/response, so `requirePermission` is NOT re-executed here — the
 * point of this test is the response contract (content type, filename, body) and
 * the audit row, both of which live in the handler. All I/O modules are mocked,
 * so nothing touches PostgreSQL or Redis.
 */
vi.mock('../../src/config/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/db/prisma', () => ({
  prisma: {
    transaction: { findMany: vi.fn() },
    publisherEarning: { findMany: vi.fn() },
  },
}));

vi.mock('../../src/services/admin.service', () => ({
  listUsersAdmin: vi.fn(),
  listChannelsAdmin: vi.fn(),
  listCampaignsAdmin: vi.fn(),
}));

vi.mock('../../src/services/analytics.service', () => ({ revenueByDay: vi.fn() }));
vi.mock('../../src/services/deposit.service', () => ({ listDepositsAdmin: vi.fn() }));
vi.mock('../../src/services/withdrawal.service', () => ({ listWithdrawalsAdmin: vi.fn() }));
vi.mock('../../src/services/audit.service', () => ({ recordAudit: vi.fn() }));

import { exportRouter } from '../../src/routes/admin/export.routes';
import { listUsersAdmin } from '../../src/services/admin.service';
import { recordAudit } from '../../src/services/audit.service';

const USER_ROW = {
  id: 'u1',
  telegramId: '123456789',
  username: 'ann',
  firstName: 'Ann',
  lastName: 'Lee',
  status: 'ACTIVE',
  isAdvertiser: true,
  isPublisher: false,
  referralCode: 'REF123',
  balanceCents: 100,
  totalEarnedCents: 0,
  totalSpentCents: 100,
  totalDepositedCents: 100,
  totalWithdrawnCents: 0,
  isAdmin: false,
  adminRole: null,
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
};

/* eslint-disable @typescript-eslint/no-explicit-any */
interface RouteLayer {
  route?: { path: string; stack: { handle: (...args: any[]) => unknown }[] };
}

/** The final handler of `router.get(path, ...)`, bypassing the middlewares. */
function handlerFor(path: string): (req: any, res: any, next: any) => Promise<void> {
  const stack = (exportRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path);
  if (!layer?.route) throw new Error(`route not registered: ${path}`);
  const handles = layer.route.stack;
  return handles[handles.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}

function makeReq() {
  return { query: {}, admin: { id: 'admin-1', role: 'ADMIN', permissions: [] } };
}

function makeRes() {
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const res = {
    headersSent: false,
    setHeader(key: string, value: unknown) {
      headers[key] = String(value);
    },
    write(chunk: unknown) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      res.headersSent = true;
    },
  };
  return { res, headers, chunks };
}

const bytes = (chunks: Buffer[]): Buffer => Buffer.concat(chunks);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/admin/export/users.xlsx', () => {
  it('returns an xlsx body with the right content type and an attachment filename', async () => {
    vi.mocked(listUsersAdmin).mockResolvedValue({ items: [USER_ROW] } as never);

    const { res, headers, chunks } = makeRes();
    const next = vi.fn();
    await handlerFor('/users.xlsx')(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(headers['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(headers['Content-Disposition']).toMatch(
      /^attachment; filename="botflow-users-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );

    const body = bytes(chunks);
    // A ZIP local file header — the workbook really is a zip.
    expect(body.readUInt32LE(0)).toBe(0x04034b50);
    expect(body.length).toBe(Number(headers['Content-Length']));
  });

  it('writes an EXPORT row whose action matches the CSV export of the same entity', async () => {
    vi.mocked(listUsersAdmin).mockResolvedValue({ items: [USER_ROW] } as never);

    // xlsx first
    const xlsx = makeRes();
    await handlerFor('/users.xlsx')(makeReq(), xlsx.res, vi.fn());
    // then the csv variant of the same entity
    const csv = makeRes();
    await handlerFor('/users.csv')(makeReq(), csv.res, vi.fn());

    expect(csv.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['Content-Disposition']).toMatch(
      /^attachment; filename="botflow-users-\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    const calls = vi.mocked(recordAudit).mock.calls;
    expect(calls).toHaveLength(2);

    const [xlsxAudit, csvAudit] = calls;
    expect(xlsxAudit[0]).toMatchObject({
      actorId: 'admin-1',
      action: 'EXPORT_USERS',
      targetType: 'EXPORT',
      newValue: { rows: 1, truncated: false },
    });
    // The audit describes the export, not the format: identical action + shape.
    expect(csvAudit[0].action).toBe(xlsxAudit[0].action);
    expect(csvAudit[0].targetType).toBe('EXPORT');
    expect(csvAudit[0].newValue).toEqual(xlsxAudit[0].newValue);
  });
});

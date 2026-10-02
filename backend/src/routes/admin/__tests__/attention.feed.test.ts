import { describe, expect, it, vi } from 'vitest';
import {
  SEVERITY_RANK,
  buildAttentionItems,
  type AttentionCounts,
  type AttentionItem,
} from '../attention.routes';

/**
 * DB-FREE unit tests for the pure half of the operator "needs attention" feed:
 * the severity ordering and the item-shape builder.
 *
 * `attention.routes.ts` pulls in Prisma at import time (for the count queries in
 * the handler), so it is mocked here — nothing connects. Only the exported pure
 * functions are exercised.
 */
vi.mock('../../../db/prisma', () => ({
  prisma: {
    deposit: { count: vi.fn() },
    withdrawal: { count: vi.fn() },
    campaign: { count: vi.fn() },
    channel: { count: vi.fn() },
    adCreativeVersion: { count: vi.fn() },
    deliveryJob: { count: vi.fn() },
    fraudEvent: { count: vi.fn() },
    report: { count: vi.fn() },
    supportTicket: { count: vi.fn() },
    cryptoChainTransfer: { count: vi.fn() },
    adminUser: { count: vi.fn() },
  },
  transaction: vi.fn(),
}));

vi.mock('../../../services/audit.service', () => ({
  recordAudit: vi.fn(async () => undefined),
}));

/** Every counter at zero, then overridden per test. */
function counts(overrides: Partial<AttentionCounts> = {}): AttentionCounts {
  return {
    pendingDeposits: 0,
    pendingWithdrawals: 0,
    campaignsAwaitingReview: 0,
    channelsAwaitingApproval: 0,
    creativeVersionsAwaitingReview: 0,
    failedDeliveryJobs24h: 0,
    unresolvedFraudEvents: 0,
    openReports: 0,
    openSupportTickets: 0,
    cryptoTransfersAwaitingCredit: 0,
    adminsWithoutPermissions: 0,
    ...overrides,
  };
}

describe('buildAttentionItems — item shape', () => {
  it('returns an empty list when every count is zero', () => {
    expect(buildAttentionItems(counts())).toEqual([]);
  });

  it('emits one item per non-zero source, and drops the zero ones', () => {
    const items = buildAttentionItems(
      counts({ pendingDeposits: 3, openSupportTickets: 7, openReports: 0 }),
    );
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain('DEPOSITS_PENDING');
    expect(kinds).toContain('SUPPORT_TICKETS_OPEN');
    expect(kinds).not.toContain('REPORTS_OPEN');
    expect(items).toHaveLength(2);
  });

  it('produces exactly the documented item shape, carrying the real count', () => {
    const items = buildAttentionItems(counts({ pendingWithdrawals: 5 }));
    expect(items).toHaveLength(1);
    const item: AttentionItem = items[0];
    expect(Object.keys(item).sort()).toEqual(
      ['count', 'detail', 'href', 'kind', 'label', 'severity'].sort(),
    );
    expect(item.count).toBe(5);
    expect(item.kind).toBe('WITHDRAWALS_PENDING');
    expect(item.severity).toBe('CRITICAL');
    expect(typeof item.label).toBe('string');
    expect(typeof item.detail).toBe('string');
  });

  it('only ever emits one of the four known severities and a real /admin href', () => {
    const items = buildAttentionItems(
      counts({
        pendingDeposits: 1,
        pendingWithdrawals: 1,
        campaignsAwaitingReview: 1,
        channelsAwaitingApproval: 1,
        creativeVersionsAwaitingReview: 1,
        failedDeliveryJobs24h: 1,
        unresolvedFraudEvents: 1,
        openReports: 1,
        openSupportTickets: 1,
        cryptoTransfersAwaitingCredit: 1,
        adminsWithoutPermissions: 1,
      }),
    );
    const allowed = new Set(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']);
    for (const item of items) {
      expect(allowed.has(item.severity)).toBe(true);
      expect(item.href.startsWith('/admin')).toBe(true);
    }
  });
});

describe('severity ordering', () => {
  it('ranks CRITICAL < HIGH < NORMAL < LOW', () => {
    expect(SEVERITY_RANK.CRITICAL).toBeLessThan(SEVERITY_RANK.HIGH);
    expect(SEVERITY_RANK.HIGH).toBeLessThan(SEVERITY_RANK.NORMAL);
    expect(SEVERITY_RANK.NORMAL).toBeLessThan(SEVERITY_RANK.LOW);
  });

  it('sorts most-urgent first across severities', () => {
    const items = buildAttentionItems(
      counts({
        openSupportTickets: 1, // NORMAL
        pendingDeposits: 1, // HIGH
        unresolvedFraudEvents: 1, // CRITICAL
      }),
    );
    expect(items.map((i) => i.severity)).toEqual(['CRITICAL', 'HIGH', 'NORMAL']);
  });

  it('is stable within one severity (declared order preserved)', () => {
    // Both are HIGH; Deposits is declared before Crypto transfers.
    const items = buildAttentionItems(counts({ cryptoTransfersAwaitingCredit: 2, pendingDeposits: 2 }));
    const highKinds = items.filter((i) => i.severity === 'HIGH').map((i) => i.kind);
    expect(highKinds).toEqual(['DEPOSITS_PENDING', 'CRYPTO_TRANSFERS_AWAITING_CREDIT']);
  });

  it('orders the full feed the same way every time', () => {
    const all = counts({
      pendingDeposits: 1,
      pendingWithdrawals: 1,
      campaignsAwaitingReview: 1,
      channelsAwaitingApproval: 1,
      creativeVersionsAwaitingReview: 1,
      failedDeliveryJobs24h: 1,
      unresolvedFraudEvents: 1,
      openReports: 1,
      openSupportTickets: 1,
      cryptoTransfersAwaitingCredit: 1,
      adminsWithoutPermissions: 1,
    });
    const first = buildAttentionItems(all).map((i) => i.kind);
    const second = buildAttentionItems(all).map((i) => i.kind);
    expect(first).toEqual(second);
    // Every CRITICAL precedes every HIGH precedes every NORMAL.
    const ranks = buildAttentionItems(all).map((i) => SEVERITY_RANK[i.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

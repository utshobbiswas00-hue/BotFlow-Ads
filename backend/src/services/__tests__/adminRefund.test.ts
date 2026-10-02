import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-FREE unit tests for the admin-initiated refund (§38).
 *
 * Two things are pinned here:
 *  1. `computeRefundableCents` — the PURE rule that decides the maximum: it can
 *     never exceed the unspent budget still held in escrow, less whatever was
 *     already refunded.
 *  2. `issueAdminRefund` — it REFUSES (rather than silently clamps) an amount
 *     above that maximum, and on the happy path it credits through the ledger
 *     with a unique per-campaign reference and records the reason in the audit
 *     row. Prisma and the audit service are mocked; no DB is touched.
 *
 * Follows the mocking style of `services/__tests__/userModeration.test.ts`.
 */
vi.mock('../../db/prisma', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/prisma')>();
  return {
    ...actual,
    prisma: {
      wallet: { findUnique: vi.fn() },
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

vi.mock('../audit.service', () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock('../transaction.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transaction.service')>();
  return {
    ...actual,
    postLedger: vi.fn(async () => ({ transaction: { id: 'ledger-tx-1' }, replayed: false })),
  };
});

import { prisma, transaction } from '../../db/prisma';
import { recordAudit } from '../audit.service';
import { postLedger } from '../transaction.service';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors';
import { computeRefundableCents, issueAdminRefund } from '../admin.service';

const walletFindUnique = vi.mocked(prisma.wallet.findUnique);
const postLedgerMock = vi.mocked(postLedger);
const audit = vi.mocked(recordAudit);
const txRunner = transaction as unknown as ReturnType<typeof vi.fn>;

const campaignFindUnique = vi.fn();
const campaignUpdate = vi.fn();
const transactionAggregate = vi.fn();

/** A fake `Prisma.TransactionClient` exposing only what the refund path uses. */
function makeTx() {
  return {
    $queryRaw: vi.fn(async () => []),
    campaign: { findUnique: campaignFindUnique, update: campaignUpdate },
    transaction: { aggregate: transactionAggregate },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  walletFindUnique.mockResolvedValue({ availableCents: 1234 } as never);
  campaignFindUnique.mockResolvedValue({
    id: 'c1',
    advertiserId: 'adv1',
    budgetTotalCents: 10_000,
    budgetSpentCents: 4_000,
    budgetReservedCents: 6_000,
  } as never);
  transactionAggregate.mockResolvedValue({ _sum: { amountCents: 0 }, _count: 0 } as never);
  campaignUpdate.mockResolvedValue({} as never);
  txRunner.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(makeTx()));
});

/* ------------------------------------------------------------------
 *  Pure refundable-amount calculation
 * ------------------------------------------------------------------ */

describe('computeRefundableCents — never more than the campaign can refund', () => {
  it('caps at the unspent budget that is still held in escrow', () => {
    expect(
      computeRefundableCents({
        budgetTotalCents: 10_000,
        budgetSpentCents: 4_000,
        budgetReservedCents: 6_000,
        alreadyRefundedCents: 0,
      }),
    ).toBe(6_000);
  });

  it('subtracts what was already refunded for this campaign', () => {
    expect(
      computeRefundableCents({
        budgetTotalCents: 10_000,
        budgetSpentCents: 4_000,
        budgetReservedCents: 6_000,
        alreadyRefundedCents: 2_500,
      }),
    ).toBe(3_500);
  });

  it('cannot refund money already spent on delivered posts', () => {
    expect(
      computeRefundableCents({
        budgetTotalCents: 10_000,
        budgetSpentCents: 10_000,
        budgetReservedCents: 5_000,
        alreadyRefundedCents: 0,
      }),
    ).toBe(0);
  });

  it('cannot refund escrow that is no longer reserved (already released)', () => {
    expect(
      computeRefundableCents({
        budgetTotalCents: 10_000,
        budgetSpentCents: 4_000,
        budgetReservedCents: 0,
        alreadyRefundedCents: 0,
      }),
    ).toBe(0);
  });

  it('never reports a negative maximum when everything is already returned', () => {
    expect(
      computeRefundableCents({
        budgetTotalCents: 10_000,
        budgetSpentCents: 0,
        budgetReservedCents: 10_000,
        alreadyRefundedCents: 10_000,
      }),
    ).toBe(0);
  });
});

/* ------------------------------------------------------------------
 *  Over-refund is refused, not clamped
 * ------------------------------------------------------------------ */

describe('issueAdminRefund — refuses rather than clamps', () => {
  it('rejects an amount above the maximum and names the maximum in the 400', async () => {
    // unspent 6000, reserved 6000, already 0 -> max 6000; 7000 is too much.
    await expect(
      issueAdminRefund('admin1', {
        campaignId: 'c1',
        amountCents: 7_000,
        reason: 'campaign overcharged by mistake',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('maximum allowed is 6000'),
    });

    expect(postLedgerMock).not.toHaveBeenCalled();
    expect(campaignUpdate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects any refund when nothing is refundable', async () => {
    campaignFindUnique.mockResolvedValue({
      id: 'c1',
      advertiserId: 'adv1',
      budgetTotalCents: 10_000,
      budgetSpentCents: 4_000,
      budgetReservedCents: 0,
    } as never);

    await expect(
      issueAdminRefund('admin1', { campaignId: 'c1', amountCents: 1, reason: 'even one cent' }),
    ).rejects.toBeInstanceOf(AppError);
    expect(postLedgerMock).not.toHaveBeenCalled();
  });

  it('404s for a campaign that does not exist', async () => {
    campaignFindUnique.mockResolvedValue(null as never);

    await expect(
      issueAdminRefund('admin1', { campaignId: 'ghost', amountCents: 100, reason: 'a valid reason' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(postLedgerMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive amount and an inadequate reason before touching the DB', async () => {
    await expect(
      issueAdminRefund('admin1', { campaignId: 'c1', amountCents: 0, reason: 'a valid reason' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      issueAdminRefund('admin1', { campaignId: 'c1', amountCents: 100, reason: 'too short' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(txRunner).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------
 *  Happy path — ledger credit + unique per-campaign reference + audit
 * ------------------------------------------------------------------ */

describe('issueAdminRefund — credits through the ledger', () => {
  it('writes a REFUND row from escrow with a per-campaign sequence and audits the reason', async () => {
    // Two prior refunds totalling 1000 -> seq 3, headroom = 6000 - 1000 = 5000.
    transactionAggregate.mockResolvedValue({ _sum: { amountCents: 1_000 }, _count: 2 } as never);

    const result = await issueAdminRefund('admin1', {
      campaignId: 'c1',
      amountCents: 1_000,
      reason: 'campaign overcharged by mistake',
    });

    expect(postLedgerMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'adv1',
        type: 'REFUND',
        amountCents: 1_000,
        reference: 'refund:admin:c1:3',
        walletDelta: { reserved: -1_000, available: 1_000, totalRefunded: 1_000 },
      }),
    );

    expect(campaignUpdate).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { budgetReservedCents: { decrement: 1_000 } },
    });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin1',
        action: 'REFUND_ISSUED',
        targetType: 'CAMPAIGN',
        targetId: 'c1',
        newValue: {
          amountCents: 1_000,
          reference: 'refund:admin:c1:3',
          reason: 'campaign overcharged by mistake',
        },
      }),
    );

    expect(result).toEqual({
      transactionId: 'ledger-tx-1',
      reference: 'refund:admin:c1:3',
      amountCents: 1_000,
      campaignId: 'c1',
      newBalanceCents: 1234,
    });
  });
});

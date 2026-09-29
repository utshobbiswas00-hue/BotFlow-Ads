import type { Prisma, Transaction, TransactionType } from '@prisma/client';
import { incrementWallet } from '../db/prisma';
import { logger } from '../config/logger';
import { ConflictError } from '../utils/errors';

/**
 * The ledger. Every movement of money in BotFlow Ads is written through
 * `postLedger` inside the same database transaction as the business change.
 *
 * Guarantees:
 *  1. `reference` is UNIQUE — a replayed webhook cannot double-credit, because
 *     the insert fails and the whole transaction rolls back.
 *  2. Wallet balances are updated with SQL arithmetic (never read-modify-write),
 *     so concurrent requests cannot lose an update.
 *  3. `balanceAfterCents` is captured for reconciliation and support queries.
 */

export interface WalletDelta {
  available?: number;
  reserved?: number;
  pending?: number;
  totalDeposited?: number;
  totalSpent?: number;
  totalEarned?: number;
  totalWithdrawn?: number;
  totalRefunded?: number;
}

export interface LedgerInput {
  userId: string;
  type: TransactionType;
  /** SIGNED amount: positive credits the user, negative debits them. */
  amountCents: number;
  /** Globally unique. Convention: `<type>:<entityId>:<suffix>` */
  reference: string;
  referenceType?: string;
  idempotencyKey?: string | null;
  walletDelta: WalletDelta;
  currency?: string;
  description?: string;
  metadata?: unknown;
  campaignId?: string | null;
  channelId?: string | null;
  adPostId?: string | null;
  withdrawalId?: string | null;
  depositId?: string | null;
  earningId?: string | null;
}

export interface PostedLedger {
  transaction: Transaction;
  /** true when a pre-existing row with the same reference was returned. */
  replayed: boolean;
}

/**
 * Which lifetime running total on the `users` row a ledger type feeds.
 *
 * The `users` totals are denormalised for dashboards (see user.service /
 * analytics.service / admin.service) and this is the ONE place they are written,
 * so every caller — present and future — keeps them in sync.
 *
 *  - `PUBLISHER_EARNING` / `REFERRAL_REWARD` are what a user has earned.
 *  - `CAMPAIGN_CHARGE` (a delivered post) and the Premium purchase (booked as
 *    `MANUAL_ADJUSTMENT`) are what a user has spent.
 *
 * Deliberately absent: `ESCROW_HOLD` is a hold, not a spend; `PLATFORM_FEE` is a
 * carve-out of the charge it accompanies with no wallet movement; deposits,
 * withdrawals, refunds and releases are not a lifetime earn or spend. The amount
 * is read from the same `walletDelta` leg the wallet movement used, so a caller
 * that declares no lifetime flow (e.g. a raw admin balance adjustment booked as
 * `MANUAL_ADJUSTMENT`) is a no-op rather than a double count.
 */
const USER_LIFETIME_TOTAL: Partial<Record<TransactionType, 'earned' | 'spent'>> = {
  PUBLISHER_EARNING: 'earned',
  REFERRAL_REWARD: 'earned',
  CAMPAIGN_CHARGE: 'spent',
  MANUAL_ADJUSTMENT: 'spent',
};

/**
 * Write one ledger entry and apply its wallet delta.
 * MUST be called inside a `transaction(...)` block together with the
 * business change it represents.
 */
export async function postLedger(
  tx: Prisma.TransactionClient,
  input: LedgerInput,
): Promise<PostedLedger> {
  // 1. Idempotency: if this exact reference already completed, return it as-is.
  const existing = await tx.transaction.findUnique({ where: { reference: input.reference } });
  if (existing) {
    if (existing.status === 'COMPLETED') {
      logger.debug({ reference: input.reference }, 'ledger replay — returning existing transaction');
      return { transaction: existing, replayed: true };
    }
    throw new ConflictError(`Transaction ${input.reference} exists in state ${existing.status}`);
  }

  // 2. Snapshot the balance BEFORE the change. Recording both sides makes each
  //    ledger row self-contained: any single entry can be audited on its own
  //    without replaying the entire history.
  const before = await tx.wallet.findUnique({
    where: { userId: input.userId },
    select: { availableCents: true },
  });

  // 3. Apply the balance change.
  await incrementWallet(tx, input.userId, input.walletDelta);

  // 4. Read back the post-change balance for the audit trail.
  const wallet = await tx.wallet.findUnique({
    where: { userId: input.userId },
    select: { availableCents: true, reservedCents: true, pendingCents: true },
  });

  // 5. Record the immutable ledger row.
  const transaction = await tx.transaction.create({
    data: {
      userId: input.userId,
      type: input.type,
      status: 'COMPLETED',
      amountCents: input.amountCents,
      currency: input.currency ?? 'USD',
      balanceBefore: before?.availableCents ?? null,
      balanceAfter: wallet?.availableCents ?? null,
      reference: input.reference,
      referenceType: input.referenceType ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      campaignId: input.campaignId ?? null,
      channelId: input.channelId ?? null,
      adPostId: input.adPostId ?? null,
      withdrawalId: input.withdrawalId ?? null,
      depositId: input.depositId ?? null,
      earningId: input.earningId ?? null,
      description: input.description ?? null,
      metadata: (input.metadata ?? null) as never,
    },
  });

  // 6. Keep the denormalised lifetime totals on `users` in sync, driven by the
  //    transaction type (see USER_LIFETIME_TOTAL). The amount comes from the
  //    wallet delta leg the caller declared, so only a real earn/spend flow
  //    moves the total and it can never be counted twice. Same tx as the money.
  const lifetimeTotal = USER_LIFETIME_TOTAL[input.type];
  if (lifetimeTotal === 'earned') {
    const earnedCents = input.walletDelta.totalEarned ?? 0;
    if (earnedCents !== 0) {
      await tx.user.update({
        where: { id: input.userId },
        data: { totalEarnedCents: { increment: earnedCents } },
      });
    }
  } else if (lifetimeTotal === 'spent') {
    const spentCents = input.walletDelta.totalSpent ?? 0;
    if (spentCents !== 0) {
      await tx.user.update({
        where: { id: input.userId },
        data: { totalSpentCents: { increment: spentCents } },
      });
    }
  }

  logger.info(
    {
      reference: input.reference,
      type: input.type,
      amountCents: input.amountCents,
      userId: input.userId,
      balanceAfter: wallet?.availableCents,
    },
    'ledger entry posted',
  );

  return { transaction, replayed: false };
}

/**
 * Recompute `balanceAfterCents` for every row of a user, oldest first.
 * Used by the reconciliation job that runs nightly and by admin tooling when
 * a balance is disputed. It does NOT modify balances — it only reports drift.
 */
export async function reconcileWallet(userId: string): Promise<{
  computedAvailableCents: number;
  storedAvailableCents: number;
  driftCents: number;
  entries: number;
}> {
  const [user, txns] = await Promise.all([
    (await import('../db/prisma')).prisma.user.findUnique({
      where: { id: userId },
      select: { wallet: { select: { availableCents: true, reservedCents: true, pendingCents: true } } },
    }),
    (await import('../db/prisma')).prisma.transaction.findMany({
      where: { userId, status: 'COMPLETED' },
      orderBy: { createdAt: 'asc' },
      select: { amountCents: true, type: true },
    }),
  ]);

  // Only types whose `amountCents` moved the `available` balance are summed
  // here. `CAMPAIGN_CHARGE` moves `reserved` (not available) so it is excluded,
  // and `ESCROW_HOLD` / `ESCROW_RELEASE` / `MANUAL_ADJUSTMENT` all move
  // `available` by exactly `amountCents` so they must be included — otherwise
  // every account with a campaign or an adjustment reports permanent noise.
  const AVAILABLE_TYPES = new Set<TransactionType>([
    'DEPOSIT',
    'REFUND',
    'REFERRAL_REWARD',
    'WITHDRAWAL',
    'ESCROW_HOLD',
    'ESCROW_RELEASE',
    'MANUAL_ADJUSTMENT',
  ]);

  const computed = txns
    .filter((t) => AVAILABLE_TYPES.has(t.type))
    .reduce((sum, t) => sum + t.amountCents, 0);

  const stored = user?.wallet?.availableCents ?? 0;

  return {
    computedAvailableCents: computed,
    storedAvailableCents: stored,
    driftCents: stored - computed,
    entries: txns.length,
  };
}

/* ------------------------------------------------------------------
 *  Reference builders — one convention, used everywhere
 * ------------------------------------------------------------------ */

export const ref = {
  deposit: (depositId: string) => `deposit:${depositId}`,
  campaignHold: (campaignId: string) => `escrow:hold:${campaignId}`,
  campaignCharge: (adPostId: string) => `charge:${adPostId}`,
  campaignRelease: (campaignId: string) => `escrow:release:${campaignId}`,
  /// Releases the reservation for ONE delivery slot (not the whole campaign).
  jobRelease: (deliveryJobId: string) => `escrow:release:job:${deliveryJobId}`,
  campaignRefund: (campaignId: string, suffix = 'cancel') => `refund:${campaignId}:${suffix}`,
  publisherEarning: (adPostId: string) => `earning:${adPostId}`,
  earningRelease: (earningId: string) => `earning:release:${earningId}`,
  withdrawal: (withdrawalId: string) => `withdrawal:${withdrawalId}`,
  withdrawalRefund: (withdrawalId: string) => `withdrawal:refund:${withdrawalId}`,
  referral: (referralId: string) => `referral:${referralId}`,
  platformFee: (adPostId: string) => `fee:${adPostId}`,
  manual: (adminId: string, nonce: string) => `manual:${adminId}:${nonce}`,
  reversal: (originalReference: string) => `reversal:${originalReference}`,
} as const;

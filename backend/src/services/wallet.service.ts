import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { InsufficientBalanceError, NotFoundError } from '../utils/errors';
import { logger } from '../config/logger';

/**
 * Wallet reads and balance guards.
 *
 * Money is never written here — all writes go through `postLedger` in
 * transaction.service.ts so there is exactly one code path that can move
 * funds. This module only answers "what is the balance?" and "may I spend it?".
 */

export interface WalletSnapshot {
  id: string;
  userId: string;
  availableCents: number;
  reservedCents: number;
  pendingCents: number;
  currency: string;
  totalDepositedCents: number;
  totalSpentCents: number;
  totalEarnedCents: number;
  totalWithdrawnCents: number;
  totalRefundedCents: number;
}

export const WALLET_SELECT = {
  id: true,
  userId: true,
  availableCents: true,
  reservedCents: true,
  pendingCents: true,
  currency: true,
  totalDepositedCents: true,
  totalSpentCents: true,
  totalEarnedCents: true,
  totalWithdrawnCents: true,
  totalRefundedCents: true,
} as const;

/** Read a wallet, creating it lazily if an old user row predates the wallet. */
export async function getWallet(userId: string): Promise<WalletSnapshot> {
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: WALLET_SELECT });
  if (wallet) return wallet;

  const created = await prisma.wallet.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: WALLET_SELECT,
  });
  return created;
}

export async function getWalletOrThrow(userId: string): Promise<WalletSnapshot> {
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: WALLET_SELECT });
  if (!wallet) throw new NotFoundError('Wallet');
  return wallet;
}

/**
 * Serialised read of a wallet with a row-level lock.
 * Call this before any spend decision inside a `transaction(...)` block —
 * without the lock, two simultaneous campaign creations could both pass the
 * balance check and overdraw the account.
 */
export async function lockWalletOrThrow(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<WalletSnapshot> {
  const rows = await tx.$queryRaw<WalletSnapshot[]>`
    SELECT id, user_id AS "userId", available_cents AS "availableCents",
           reserved_cents AS "reservedCents", pending_cents AS "pendingCents",
           currency, total_deposited_cents AS "totalDepositedCents",
           total_spent_cents AS "totalSpentCents", total_earned_cents AS "totalEarnedCents",
           total_withdrawn_cents AS "totalWithdrawnCents",
           total_refunded_cents AS "totalRefundedCents"
    FROM wallets
    WHERE user_id = ${userId}
    FOR UPDATE
  `;

  const wallet = rows[0];
  if (wallet) return wallet;

  // Wallet is missing (very old account) — create it, then lock again.
  await tx.wallet.create({ data: { userId } });
  const retry = await tx.$queryRaw<WalletSnapshot[]>`
    SELECT id, user_id AS "userId", available_cents AS "availableCents",
           reserved_cents AS "reservedCents", pending_cents AS "pendingCents",
           currency, total_deposited_cents AS "totalDepositedCents",
           total_spent_cents AS "totalSpentCents", total_earned_cents AS "totalEarnedCents",
           total_withdrawn_cents AS "totalWithdrawnCents",
           total_refunded_cents AS "totalRefundedCents"
    FROM wallets
    WHERE user_id = ${userId}
    FOR UPDATE
  `;
  if (!retry[0]) throw new NotFoundError('Wallet');
  return retry[0];
}

/** Throws InsufficientBalanceError unless `amountCents` is spendable. */
export function assertCanSpend(wallet: WalletSnapshot, amountCents: number): void {
  if (amountCents <= 0) return;
  if (wallet.availableCents < amountCents) {
    throw new InsufficientBalanceError('Insufficient available balance for this operation', {
      requiredCents: amountCents,
      availableCents: wallet.availableCents,
    });
  }
}

/** Throws unless the amount is withdrawable (available minus any hold). */
export function assertCanWithdraw(
  wallet: WalletSnapshot,
  amountCents: number,
  feeCents = 0,
): void {
  const required = amountCents + feeCents;
  if (wallet.availableCents < required) {
    throw new InsufficientBalanceError('Insufficient balance for this withdrawal', {
      requiredCents: required,
      availableCents: wallet.availableCents,
    });
  }
}

/**
 * The amount a user may actually withdraw.
 * Reserved campaign escrow and pending earnings are NOT withdrawable.
 */
export function withdrawableCents(wallet: WalletSnapshot): number {
  return Math.max(0, wallet.availableCents);
}

/** Total value the user holds inside the platform, for dashboards. */
export function netWorthCents(wallet: WalletSnapshot): number {
  return wallet.availableCents + wallet.reservedCents + wallet.pendingCents;
}

/** Nightly integrity check — logs loudly when a balance ever goes negative. */
export async function auditNegativeBalances(limit = 100): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ user_id: string; available_cents: number }>>`
    SELECT user_id, available_cents
    FROM wallets
    WHERE available_cents < 0 OR reserved_cents < 0 OR pending_cents < 0
    LIMIT ${limit}
  `;

  for (const row of rows) {
    logger.error({ userId: row.user_id, availableCents: row.available_cents }, 'NEGATIVE BALANCE DETECTED');
  }
  return rows.map((r) => r.user_id);
}

import type { Prisma, Withdrawal, WithdrawalStatus } from '@prisma/client';
import { prisma, transaction } from '../db/prisma';
import { postLedger, ref } from './transaction.service';
import { assertCanWithdraw, lockWalletOrThrow } from './wallet.service';
import { checkWithdrawalLimits } from './payoutLimits.service';
import { entitlementsFor } from './premium.service';
import { businessRules } from './settings.service';
import { createNotification } from './notification.service';
import { recordAudit } from './audit.service';
import { buildPaginated, type Pagination } from '../utils/pagination';
import { displayName } from '../utils/format';
import { formatMoney, assertPositiveCents } from '../utils/money';
import { encryptJson, maskAccount } from '../utils/crypto';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../config/logger';

/**
 * Withdrawals — money OUT.
 *
 * The user's funds are debited the MOMENT the withdrawal is requested
 * (inside one transaction: row lock → balance check → ledger debit →
 * withdrawal row). This makes double-spend impossible: two concurrent
 * requests serialise on the wallet row lock, and the second one sees the
 * reduced balance.
 *
 * If the admin later REJECTS the withdrawal, the full amount (principal
 * plus fee) is refunded through the ledger with the unique reference
 * `withdrawal:refund:<id>`, so a double rejection cannot double-refund.
 *
 * Account details are encrypted at rest (AES-256-GCM) and only a masked
 * version is ever displayed.
 */

export interface CreateWithdrawalInput {
  amountCents: number;
  method: string;
  accountDetails: Record<string, string>;
}

/* ------------------------------------------------------------------
 *  Create
 * ------------------------------------------------------------------ */

export async function createWithdrawal(userId: string, input: CreateWithdrawalInput): Promise<Withdrawal> {
  assertPositiveCents(input.amountCents, 'withdrawal amount');
  if (!input.accountDetails || Object.keys(input.accountDetails).length === 0) {
    throw new ValidationError('Withdrawal account details are required');
  }

  // The minimum withdrawal is the user's ENTITLEMENT value (premium plans can
  // lower it); with no active subscription it resolves to the FREE baseline
  // (500 cents = $5), unchanged. `maxWithdrawalCents` stays a global business
  // rule. This is the same number `checkWithdrawalLimits` re-checks inside the
  // transaction.
  const [ent, maxCents, feeCents, methods] = await Promise.all([
    entitlementsFor(userId),
    businessRules.maxWithdrawalCents(),
    businessRules.withdrawalFeeCents(),
    businessRules.allowedWithdrawalMethods(),
  ]);
  const minCents = ent.minWithdrawalCents;

  if (input.amountCents < minCents) {
    throw new ValidationError(`Minimum withdrawal is ${formatMoney(minCents)}`);
  }
  if (input.amountCents > maxCents) {
    throw new ValidationError(`Maximum withdrawal is ${formatMoney(maxCents)}`);
  }
  if (!methods.includes(input.method)) {
    throw new ValidationError(
      `Withdrawal method '${input.method}' is not allowed. Allowed methods: ${methods.join(', ')}`,
    );
  }

  // `amountCents` is the amount PAID OUT to the user (what the UI field and the
  // "Min $5 · max $2000" copy promise). The fee is charged ON TOP and both leave
  // `available` — see the debit below and `assertCanWithdraw`. Charging the fee
  // out of `amountCents` as well would take it twice:
  //   debited (amount + fee) === payout (netAmountCents) + fee.
  // With a zero fee this is identical to the old behaviour.
  const netAmountCents = input.amountCents;
  const firstAccount = Object.values(input.accountDetails)[0];

  return transaction(
    async (tx) => {
      // 1. Row-lock the wallet so concurrent withdrawals serialise.
      const wallet = await lockWalletOrThrow(tx, userId);

      // 2. The fee comes out of the same balance.
      assertCanWithdraw(wallet, input.amountCents, feeCents);

      // 3. Payout limits. Checked HERE — after the wallet lock and inside the
      //    transaction — not at the route: the row lock serialises this user's
      //    withdrawals, so the 24h/30d sums and the pending count cannot be
      //    raced by two simultaneous requests. A limit breach refuses the
      //    request; a "review" signal lets it through but marks it.
      const limits = await checkWithdrawalLimits(userId, input.amountCents, tx);
      if (!limits.allowed) {
        throw new ValidationError(limits.reasons.join(' '), { reasons: limits.reasons });
      }

      // 4. The withdrawal row — details encrypted, only a masked copy stored.
      const withdrawal = await tx.withdrawal.create({
        data: {
          userId,
          status: 'PENDING',
          amountCents: input.amountCents,
          feeCents,
          netAmountCents,
          method: input.method,
          accountDetails: encryptJson(input.accountDetails),
          accountMasked: firstAccount ? maskAccount(firstAccount) : null,
          requiresReview: limits.requiresManualReview,
        },
      });

      // 5. Debit immediately: principal + fee leave `available`.
      await postLedger(tx, {
        userId,
        type: 'WITHDRAWAL',
        amountCents: -(input.amountCents + feeCents),
        reference: ref.withdrawal(withdrawal.id),
        referenceType: 'WITHDRAWAL',
        walletDelta: {
          available: -(input.amountCents + feeCents),
          totalWithdrawn: input.amountCents,
        },
        withdrawalId: withdrawal.id,
        description: `Withdrawal requested via ${input.method}`,
      });

      // 6. Keep the denormalised user total in sync (ledger is the source of truth).
      await tx.user.update({
        where: { id: userId },
        data: { totalWithdrawnCents: { increment: input.amountCents } },
      });

      return withdrawal;
    },
    { retries: 2 },
  );
}

/* ------------------------------------------------------------------
 *  Read
 * ------------------------------------------------------------------ */

export async function listWithdrawals(userId: string, p: Pagination) {
  const where: Prisma.WithdrawalWhereInput = { userId };

  const [total, items] = await Promise.all([
    prisma.withdrawal.count({ where }),
    prisma.withdrawal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        status: true,
        amountCents: true,
        feeCents: true,
        netAmountCents: true,
        currency: true,
        method: true,
        accountMasked: true,
        txRef: true,
        rejectReason: true,
        note: true,
        processedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  return buildPaginated(items, total, p);
}

export interface AdminWithdrawalItem {
  id: string;
  userName: string;
  amountCents: number;
  netAmountCents: number;
  method: string;
  status: WithdrawalStatus;
  accountMasked: string | null;
  /** Flagged by the payout limits — review before approving. */
  requiresReview: boolean;
  createdAt: Date;
}

/**
 * Whitelisted sort keys for the admin withdrawals list (§79). The route
 * validates the `sort` query param with `z.enum(WITHDRAWAL_SORT_KEYS)` and
 * `withdrawalOrderBy` maps a key to an explicit Prisma `orderBy`, so a client
 * string never reaches the query builder.
 */
export const WITHDRAWAL_SORT_KEYS = [
  'created_at',
  'created_at_desc',
  'amount',
  'amount_desc',
] as const;

export type WithdrawalSortKey = (typeof WITHDRAWAL_SORT_KEYS)[number];

/**
 * Map a validated sort key to an explicit Prisma `orderBy`. Exhaustive over the
 * union: a value outside `WITHDRAWAL_SORT_KEYS` is a compile-time error.
 */
export function withdrawalOrderBy(sort: WithdrawalSortKey): Prisma.WithdrawalOrderByWithRelationInput {
  switch (sort) {
    case 'created_at':
      return { createdAt: 'asc' };
    case 'created_at_desc':
      return { createdAt: 'desc' };
    case 'amount':
      return { amountCents: 'asc' };
    case 'amount_desc':
      return { amountCents: 'desc' };
  }
}

/** Optional §79 filters; all absent by default so existing callers are unchanged. */
export interface AdminListWithdrawalsFilter {
  status?: WithdrawalStatus;
  /** Inclusive start of the window (the `createdAt` column). */
  from?: Date;
  /** Exclusive end of the window. */
  to?: Date;
  /** Whitelisted sort key; omitted keeps the default ordering. */
  sort?: WithdrawalSortKey;
}

export async function listWithdrawalsAdmin(
  filter: AdminListWithdrawalsFilter,
  p: Pagination,
): Promise<{
  items: AdminWithdrawalItem[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}> {
  const where: Prisma.WithdrawalWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
    // Date filter maps to Withdrawal.createdAt — the column this list orders by.
    // NOTE: the schema only has @@index([userId, createdAt]) and @@index([status]),
    // so the admin-wide range scan wants @@index([createdAt]) to stay fast. The
    // amount sort likewise has no index.
    ...(filter.from || filter.to
      ? {
          createdAt: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lt: filter.to } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.withdrawal.count({ where }),
    prisma.withdrawal.findMany({
      where,
      // Default preserved: newest withdrawals first when no `sort` is given.
      orderBy: filter.sort ? withdrawalOrderBy(filter.sort) : { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        amountCents: true,
        netAmountCents: true,
        method: true,
        status: true,
        accountMasked: true,
        requiresReview: true,
        createdAt: true,
        user: { select: { username: true, firstName: true, lastName: true } },
      },
    }),
  ]);

  const items: AdminWithdrawalItem[] = rows.map((w) => ({
    id: w.id,
    userName: displayName(w.user),
    amountCents: w.amountCents,
    netAmountCents: w.netAmountCents,
    method: w.method,
    status: w.status,
    accountMasked: w.accountMasked,
    requiresReview: w.requiresReview,
    createdAt: w.createdAt,
  }));

  return buildPaginated(items, total, p);
}

/* ------------------------------------------------------------------
 *  Admin transitions
 * ------------------------------------------------------------------ */

/**
 * Approve a PENDING withdrawal. No money moves here — the wallet was
 * already debited at request time. Approval just marks it for payout.
 */
export async function approveWithdrawal(adminId: string, id: string, note?: string): Promise<Withdrawal> {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id } });
  if (!withdrawal) throw new NotFoundError('Withdrawal');
  if (withdrawal.status !== 'PENDING') {
    throw new ConflictError(`Cannot approve a withdrawal in status ${withdrawal.status}`);
  }

  // Conditional transition: if a second admin approves (or rejects) the same row
  // at the same moment, only one of them may record who did it. A plain update
  // would silently overwrite `processedById` and lose the audit trail.
  const claimed = await prisma.withdrawal.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status: 'APPROVED',
      processedById: adminId,
      processedAt: new Date(),
      note: note ?? null,
    },
  });
  if (claimed.count === 0) {
    throw new ConflictError('This withdrawal has already been processed by someone else');
  }

  const updated = await prisma.withdrawal.findUniqueOrThrow({ where: { id } });

  await recordAudit({
    actorId: adminId,
    action: 'WITHDRAWAL_APPROVED',
    targetType: 'WITHDRAWAL',
    targetId: id,
    oldValue: { status: 'PENDING' },
    newValue: { status: 'APPROVED' },
  });

  await createNotification({
    userId: withdrawal.userId,
    type: 'WITHDRAWAL_APPROVED',
    title: 'Withdrawal approved',
    body: `Your withdrawal of ${formatMoney(withdrawal.netAmountCents, withdrawal.currency)} via ${withdrawal.method} has been approved and is being processed.`,
    data: { withdrawalId: id, amountCents: withdrawal.amountCents, netAmountCents: withdrawal.netAmountCents },
  });

  return updated;
}

/**
 * Reject a withdrawal and refund the user's full amount (principal + fee)
 * back to their available balance. Idempotent per withdrawal via the
 * unique ledger reference `withdrawal:refund:<id>`.
 */
export async function rejectWithdrawal(adminId: string, id: string, reason: string): Promise<Withdrawal> {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id } });
  if (!withdrawal) throw new NotFoundError('Withdrawal');
  if (withdrawal.status !== 'PENDING' && withdrawal.status !== 'APPROVED') {
    throw new ConflictError(`Cannot reject a withdrawal in status ${withdrawal.status}`);
  }

  const refundCents = withdrawal.amountCents + withdrawal.feeCents;

  const updated = await transaction(
    async (tx) => {
      // Conditional transition, claimed FIRST. Two admins rejecting the same
      // withdrawal at once would otherwise both pass the check above, both write
      // a REJECTED status, and silently overwrite each other's reason and
      // identity. With the guard, exactly one wins and the other gets a conflict
      // — which is also what keeps the refund to a single ledger entry.
      const claimed = await tx.withdrawal.updateMany({
        where: { id, status: { in: ['PENDING', 'APPROVED'] } },
        data: {
          status: 'REJECTED',
          rejectReason: reason,
          processedById: adminId,
          processedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        throw new ConflictError('This withdrawal has already been processed by someone else');
      }

      // Refund the whole debited amount (principal + fee) through the ledger.
      await postLedger(tx, {
        userId: withdrawal.userId,
        type: 'REFUND',
        amountCents: refundCents,
        reference: ref.withdrawalRefund(id),
        referenceType: 'WITHDRAWAL_REFUND',
        walletDelta: {
          available: refundCents,
          totalWithdrawn: -withdrawal.amountCents,
        },
        withdrawalId: id,
        description: `Withdrawal rejected: ${reason}`,
      });

      // Undo the denormalised total incremented at request time.
      await tx.user.update({
        where: { id: withdrawal.userId },
        data: { totalWithdrawnCents: { decrement: withdrawal.amountCents } },
      });

      return tx.withdrawal.findUniqueOrThrow({ where: { id } });
    },
    { retries: 2 },
  );

  await recordAudit({
    actorId: adminId,
    action: 'WITHDRAWAL_REJECTED',
    targetType: 'WITHDRAWAL',
    targetId: id,
    oldValue: { status: withdrawal.status },
    newValue: { status: 'REJECTED', reason },
  });

  await createNotification({
    userId: withdrawal.userId,
    type: 'WITHDRAWAL_REJECTED',
    title: 'Withdrawal rejected',
    body: `Your withdrawal of ${formatMoney(withdrawal.amountCents, withdrawal.currency)} was rejected (${reason}). The full amount, including fees, has been returned to your available balance.`,
    data: { withdrawalId: id, refundCents, reason },
  });

  return updated;
}

/**
 * Mark an approved withdrawal as paid out. The payout itself (the on-chain
 * transfer) happens outside the platform; this records proof (`txRef`).
 */
export async function markWithdrawalPaid(adminId: string, id: string, txRef: string): Promise<Withdrawal> {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id } });
  if (!withdrawal) throw new NotFoundError('Withdrawal');
  if (withdrawal.status !== 'APPROVED' && withdrawal.status !== 'PROCESSING') {
    throw new ConflictError(`Cannot mark a withdrawal in status ${withdrawal.status} as paid`);
  }

  // Conditional, like approve/reject: the payout reference is proof of an
  // off-platform transfer, so it must not be overwritten by a second admin
  // clicking "mark as paid" with a different reference.
  const claimed = await prisma.withdrawal.updateMany({
    where: { id, status: { in: ['APPROVED', 'PROCESSING'] } },
    data: {
      status: 'PAID',
      processedById: adminId,
      processedAt: new Date(),
      txRef,
    },
  });
  if (claimed.count === 0) {
    throw new ConflictError('This withdrawal has already been paid or processed by someone else');
  }

  const updated = await prisma.withdrawal.findUniqueOrThrow({ where: { id } });

  await recordAudit({
    actorId: adminId,
    action: 'WITHDRAWAL_PAID',
    targetType: 'WITHDRAWAL',
    targetId: id,
    oldValue: { status: withdrawal.status },
    newValue: { status: 'PAID', txRef },
  });

  await createNotification({
    userId: withdrawal.userId,
    type: 'WITHDRAWAL_PAID',
    title: 'Withdrawal paid',
    body: `Your withdrawal of ${formatMoney(withdrawal.netAmountCents, withdrawal.currency)} via ${withdrawal.method} has been paid out.`,
    data: { withdrawalId: id, txRef },
  });

  logger.info({ withdrawalId: id, txRef, adminId }, 'withdrawal marked as paid');

  return updated;
}

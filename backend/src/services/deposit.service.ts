import type { Deposit, DepositStatus, Prisma } from '@prisma/client';
import { prisma, transaction } from '../db/prisma';
import { postLedger, ref } from './transaction.service';
import { createNotification } from './notification.service';
import { settleReferralForUser } from './referral.service';
import { recordAudit } from './audit.service';
import { buildPaginated, type Pagination } from '../utils/pagination';
import { displayName } from '../utils/format';
import { formatMoney, assertPositiveCents } from '../utils/money';
import { feeColumnsForDeposit } from './paymentFee.service';
import { ConflictError, NotFoundError } from '../utils/errors';
import { logger } from '../config/logger';

/**
 * Deposits — money IN.
 *
 * Users declare a payment (crypto or Telegram Stars) and an admin
 * verifies it against the gateway before funds are credited. The credit
 * itself is the ONLY place a deposit moves money, and it happens through
 * `postLedger` inside a transaction — never by writing the wallet directly.
 *
 * Idempotency:
 *  - `gatewayRef` is unique, so a replayed gateway webhook returns the
 *    existing row instead of creating a duplicate deposit.
 *  - `verifyDeposit` re-reads the row inside the transaction and only
 *    credits while status is PENDING; the ledger reference
 *    `deposit:<id>` is unique as a second line of defence.
 */

export interface CreateDepositInput {
  amountCents: number;
  method: string;
  proofUrl?: string | null;
  senderInfo?: string | null;
  gatewayRef?: string | null;
}

/* ------------------------------------------------------------------
 *  Create / read
 * ------------------------------------------------------------------ */

export async function createDeposit(userId: string, input: CreateDepositInput): Promise<Deposit> {
  assertPositiveCents(input.amountCents, 'deposit amount');

  // Gateway replay protection: if this gateway reference is already known
  // (webhook fired twice, user retried), return the existing row as-is.
  if (input.gatewayRef) {
    const existing = await prisma.deposit.findUnique({ where: { gatewayRef: input.gatewayRef } });
    // A reference is a replay only for the SAME depositor. Returning another
    // user's row here would disclose it and would let a caller pre-seed a
    // gateway reference that a later credit resolves to (the credited amount
    // would then be the caller-chosen one, not the money that actually moved).
    if (existing && existing.userId !== userId) {
      throw new ConflictError('That payment reference is already in use.');
    }
    if (existing) {
      logger.info({ gatewayRef: input.gatewayRef, depositId: existing.id }, 'deposit gateway replay — returning existing row');
      return existing;
    }
  }

  // Freeze what this rail costs us on the row itself (see paymentFee.service).
  // An unknown method throws here, before anything is written — a deposit whose
  // true economics we cannot state is worse than a refused one.
  const fee = await feeColumnsForDeposit(input.method, input.amountCents);

  return prisma.deposit.create({
    data: {
      userId,
      amountCents: input.amountCents,
      method: input.method,
      status: 'PENDING',
      feeBps: fee.feeBps,
      feeCents: fee.feeCents,
      gatewayRef: input.gatewayRef ?? null,
      proofUrl: input.proofUrl ?? null,
      senderInfo: input.senderInfo ?? null,
    },
  });
}

export async function listDeposits(userId: string, p: Pagination) {
  const where: Prisma.DepositWhereInput = { userId };

  const [total, items] = await Promise.all([
    prisma.deposit.count({ where }),
    prisma.deposit.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        amountCents: true,
        currency: true,
        method: true,
        status: true,
        gatewayRef: true,
        proofUrl: true,
        senderInfo: true,
        verifiedAt: true,
        note: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  return buildPaginated(items, total, p);
}

export interface AdminDepositItem {
  id: string;
  userName: string;
  amountCents: number;
  method: string;
  status: DepositStatus;
  proofUrl: string | null;
  createdAt: Date;
}

/**
 * Whitelisted sort keys for the admin deposits list (§79). The route validates
 * the `sort` query param with `z.enum(DEPOSIT_SORT_KEYS)` and `depositOrderBy`
 * maps a key to an explicit Prisma `orderBy`, so a client string never reaches
 * the query builder.
 */
export const DEPOSIT_SORT_KEYS = [
  'created_at',
  'created_at_desc',
  'amount',
  'amount_desc',
] as const;

export type DepositSortKey = (typeof DEPOSIT_SORT_KEYS)[number];

/**
 * Map a validated sort key to an explicit Prisma `orderBy`. Exhaustive over the
 * union: a value outside `DEPOSIT_SORT_KEYS` is a compile-time error.
 */
export function depositOrderBy(sort: DepositSortKey): Prisma.DepositOrderByWithRelationInput {
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
export interface AdminListDepositsFilter {
  status?: DepositStatus;
  /** Inclusive start of the window (the `createdAt` column). */
  from?: Date;
  /** Exclusive end of the window. */
  to?: Date;
  /** Whitelisted sort key; omitted keeps the default ordering. */
  sort?: DepositSortKey;
}

export async function listDepositsAdmin(
  filter: AdminListDepositsFilter,
  p: Pagination,
): Promise<{
  items: AdminDepositItem[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}> {
  const where: Prisma.DepositWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
    // Date filter maps to Deposit.createdAt — the column this list orders by.
    // NOTE: the schema only has @@index([userId, createdAt]) and @@index([status]),
    // so the admin-wide (unscoped by user) range scan wants @@index([createdAt])
    // to stay fast at scale. The amount sort likewise has no index.
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
    prisma.deposit.count({ where }),
    prisma.deposit.findMany({
      where,
      // Default preserved: newest deposits first when no `sort` is given.
      orderBy: filter.sort ? depositOrderBy(filter.sort) : { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        amountCents: true,
        method: true,
        status: true,
        proofUrl: true,
        createdAt: true,
        user: { select: { username: true, firstName: true, lastName: true } },
      },
    }),
  ]);

  const items: AdminDepositItem[] = rows.map((d) => ({
    id: d.id,
    userName: displayName(d.user),
    amountCents: d.amountCents,
    method: d.method,
    status: d.status,
    proofUrl: d.proofUrl,
    createdAt: d.createdAt,
  }));

  return buildPaginated(items, total, p);
}

/* ------------------------------------------------------------------
 *  Admin transitions
 * ------------------------------------------------------------------ */

/**
 * Verify a PENDING deposit and credit the user's wallet.
 * IDEMPOTENT: a second call (or a concurrent race) finds the deposit
 * already VERIFIED and returns it without moving money again.
 *
 * `meta` lets a non-admin caller (the payment-gateway webhook) record the
 * gateway's own identifiers and the raw callback beside the credit, without a
 * second write path that could drift from this one. The ledger reference
 * `deposit:<id>` is identical for both callers on purpose: if an admin and the
 * gateway both act, the unique index turns the second one into a no-op rather
 * than a double credit.
 */
export async function verifyDeposit(
  adminId: string,
  depositId: string,
  note?: string,
  meta?: { gatewayTxnId?: string | null; rawPayload?: unknown },
): Promise<Deposit> {
  const { deposit, alreadyVerified } = await transaction(
    async (tx) => {
      // Serialize concurrent verifications on the deposit row (SELECT … FOR
      // UPDATE). Without the lock two callers both read PENDING and race the
      // credit; the loser only failed on the unique ledger reference and rolled
      // the whole transaction back instead of being reported as a duplicate.
      // With the lock the second caller waits, then re-reads the committed row.
      await tx.$queryRaw`SELECT id FROM "deposits" WHERE id = ${depositId} FOR UPDATE`;

      const deposit = await tx.deposit.findUnique({ where: { id: depositId } });
      if (!deposit) throw new NotFoundError('Deposit');

      // Idempotent guard: only a PENDING deposit can be verified.
      if (deposit.status !== 'PENDING') {
        logger.debug({ depositId, status: deposit.status }, 'verifyDeposit: already processed, returning early');
        return { deposit, alreadyVerified: true };
      }

      // THE DEPOSITOR PAYS THE RAIL FEE: only the remainder is credited.
      // `amountCents` is what they sent; `feeCents` is what the platform keeps.
      // Crediting amountCents here would hand the depositor our cut — the fee
      // was frozen on this row at creation precisely so the two cannot drift.
      const creditedCents = deposit.amountCents - deposit.feeCents;

      // Credit the wallet through the ledger — the unique reference
      // `deposit:<id>` makes a double-credit impossible even under race.
      await postLedger(tx, {
        userId: deposit.userId,
        type: 'DEPOSIT',
        amountCents: creditedCents,
        reference: ref.deposit(deposit.id),
        referenceType: 'DEPOSIT',
        walletDelta: { available: creditedCents, totalDeposited: creditedCents },
        depositId: deposit.id,
        description:
          deposit.feeCents > 0
            ? `Deposit verified (net of ${deposit.feeBps / 100}% payment fee)`
            : 'Deposit verified',
      });

      const updated = await tx.deposit.update({
        where: { id: deposit.id },
        data: {
          status: 'VERIFIED',
          verifiedById: adminId,
          verifiedAt: new Date(),
          note: note ?? null,
          ...(meta?.gatewayTxnId !== undefined ? { gatewayTxnId: meta.gatewayTxnId } : {}),
          ...(meta?.rawPayload !== undefined
            ? { rawPayload: meta.rawPayload as never }
            : {}),
        },
      });

      // Keep the denormalised user total in sync (ledger stays the source of truth).
      // Net, to match what the wallet actually received.
      await tx.user.update({
        where: { id: deposit.userId },
        data: { totalDepositedCents: { increment: creditedCents } },
      });

      return { deposit: updated, alreadyVerified: false };
    },
    { retries: 2 },
  );

  if (!alreadyVerified) {
    await createNotification({
      userId: deposit.userId,
      type: 'DEPOSIT_VERIFIED',
      title: 'Deposit confirmed',
      // Say what actually landed, and why it is less than they sent — a balance
      // that quietly shrinks by the fee is exactly how a deposit dispute starts.
      body:
        deposit.feeCents > 0
          ? `Your deposit of ${formatMoney(deposit.amountCents, deposit.currency)} is confirmed. ${formatMoney(deposit.amountCents - deposit.feeCents, deposit.currency)} was added to your available balance after the ${deposit.feeBps / 100}% payment fee.`
          : `Your deposit of ${formatMoney(deposit.amountCents, deposit.currency)} has been verified and added to your available balance.`,
      data: {
        depositId: deposit.id,
        amountCents: deposit.amountCents,
        feeCents: deposit.feeCents,
        creditedCents: deposit.amountCents - deposit.feeCents,
        currency: deposit.currency,
      },
    });

    await recordAudit({
      actorId: adminId,
      action: 'DEPOSIT_VERIFIED',
      targetType: 'DEPOSIT',
      targetId: depositId,
      oldValue: { status: 'PENDING' },
      newValue: {
        status: 'VERIFIED',
        amountCents: deposit.amountCents,
        feeBps: deposit.feeBps,
        feeCents: deposit.feeCents,
        creditedCents: deposit.amountCents - deposit.feeCents,
      },
    });

    // A verified deposit is what makes the referred user "real", and therefore
    // what unlocks their referrer's reward. Settled here so the referrer is paid
    // immediately rather than waiting for the next sweep. Never throws: a
    // referral problem must not undo a confirmed deposit.
    await settleReferralForUser(deposit.userId);
  }

  return deposit;
}

export async function rejectDeposit(adminId: string, depositId: string, note: string): Promise<Deposit> {
  // Symmetric to verifyDeposit: we lock the row, claim the PENDING status via
  // updateMany, and either exactly one admin wins the race or the loser sees a
  // conflict. The earlier findUnique + update pair was readable but raced —
  // two admins could each pass the status check, both write REJECTED, and the
  // second silently overwrote the first's note and identity.
  const claimed = await prisma.deposit.updateMany({
    where: { id: depositId, status: 'PENDING' },
    data: {
      status: 'REJECTED',
      verifiedById: adminId,
      verifiedAt: new Date(),
      note,
    },
  });
  if (claimed.count === 0) {
    throw new ConflictError(
      'This deposit has already been processed by someone else or is no longer pending.',
    );
  }

  const updated = await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });

  await recordAudit({
    actorId: adminId,
    action: 'DEPOSIT_REJECTED',
    targetType: 'DEPOSIT',
    targetId: depositId,
    oldValue: { status: 'PENDING' },
    newValue: { status: 'REJECTED', note },
  });

  return updated;
}

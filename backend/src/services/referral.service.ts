import type { Prisma, Referral, ReferralStatus } from '@prisma/client';
import { prisma, transaction } from '../db/prisma';
import { postLedger, ref } from './transaction.service';
import { businessRules } from './settings.service';
import { referralFraudCheck, type ReferralFraudResult } from './payoutLimits.service';
import { recordFraudEvent } from './fraud.service';
import { entitlementsFor } from './premium.service';
import { buildPaginated, type Pagination, type PaginatedResult } from '../utils/pagination';
import { displayName } from '../utils/format';
import { NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../config/logger';

/**
 * Referrals.
 *
 * When a user signs up with a referral code, a `Referral` row links
 * referrer → referred user and stays PENDING until the referred account is
 * eligible (e.g. completed KYC / first verified activity). `rewardReferral`
 * then credits the referrer through the ledger with the unique reference
 * `referral:<id>` — so a referral can be rewarded exactly once, no matter
 * how many times the reward job fires.
 */

export interface ReferralSummary {
  referralCode: string;
  totalReferrals: number;
  totalRewardedCents: number;
  referrals: PaginatedResult<{
    name: string;
    status: ReferralStatus;
    rewardCents: number;
    createdAt: Date;
  }>;
}

export async function getReferralSummary(userId: string, p: Pagination): Promise<ReferralSummary> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, referralCode: true },
  });
  if (!user) throw new NotFoundError('User');

  const where: Prisma.ReferralWhereInput = { referrerId: userId };

  const [total, rewardedSum, rows] = await Promise.all([
    prisma.referral.count({ where }),
    prisma.referral.aggregate({
      where: { ...where, status: 'REWARDED' },
      _sum: { rewardCents: true },
    }),
    prisma.referral.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        status: true,
        rewardCents: true,
        createdAt: true,
        referredUser: { select: { username: true, firstName: true, lastName: true } },
      },
    }),
  ]);

  return {
    referralCode: user.referralCode,
    totalReferrals: total,
    totalRewardedCents: rewardedSum._sum.rewardCents ?? 0,
    referrals: buildPaginated(
      rows.map((r) => ({
        name: displayName(r.referredUser),
        status: r.status,
        rewardCents: r.rewardCents,
        createdAt: r.createdAt,
      })),
      total,
      p,
    ),
  };
}

/**
 * Reward a PENDING referral: credit the referrer's available balance and
 * mark the referral REWARDED. IDEMPOTENT — a referral that is not PENDING
 * is returned unchanged and no money moves.
 */
export async function rewardReferral(referralId: string): Promise<Referral> {
  const referral = await prisma.referral.findUnique({ where: { id: referralId } });
  if (!referral) throw new NotFoundError('Referral');

  // Not pending (already rewarded / rejected) — nothing to do.
  if (referral.status !== 'PENDING') {
    logger.debug({ referralId, status: referral.status }, 'rewardReferral: not PENDING, skipping');
    return referral;
  }

  const baseRewardCents = await businessRules.referralRewardCents();
  if (!Number.isInteger(baseRewardCents) || baseRewardCents <= 0) {
    throw new ValidationError('Referral reward is not enabled or is misconfigured');
  }

  // A Premium/Business referrer earns a bonus on top of the standard reward —
  // `referralBonusPercent` is one of the paid-plan perks shown on the pricing
  // page; this is what actually pays it out, rather than it being a display-only
  // number. `entitlementsFor` already returns 0 for a free account, so this is a
  // no-op for the common case.
  const referrerEntitlements = await entitlementsFor(referral.referrerId);
  const bonusPct = Math.max(0, referrerEntitlements.referralBonusPercent);
  const rewardCents = Math.round(baseRewardCents * (1 + bonusPct / 100));

  return transaction(
    async (tx) => {
      // Re-read inside the transaction: under a race, a concurrent call
      // may have committed first — in that case we return without crediting.
      const current = await tx.referral.findUnique({ where: { id: referralId } });
      if (!current) throw new NotFoundError('Referral');
      if (current.status !== 'PENDING') return current;

      await postLedger(tx, {
        userId: current.referrerId,
        type: 'REFERRAL_REWARD',
        amountCents: rewardCents,
        reference: ref.referral(current.id),
        referenceType: 'REFERRAL_REWARD',
        walletDelta: { available: rewardCents, totalEarned: rewardCents },
        description: 'Referral reward',
      });

      const updated = await tx.referral.update({
        where: { id: current.id },
        data: {
          status: 'REWARDED',
          rewardCents,
          rewardedAt: new Date(),
        },
      });

      logger.info({ referralId, referrerId: current.referrerId, rewardCents }, 'referral rewarded');
      return updated;
    },
    { retries: 2 },
  );
}

/* ------------------------------------------------------------------
 *  Signup wiring
 * ------------------------------------------------------------------ */

export interface RecordReferralResult {
  /** A `Referral` row was created (false when blocked, or already present). */
  created: boolean;
  referralId: string | null;
  /** Mirrors referralFraudCheck.allowed — false ONLY for self-referral. */
  allowed: boolean;
  /** Whether the reward conditions are already met (almost never at signup). */
  rewardEligible: boolean;
  reasons: string[];
}

/**
 * Called when a brand-new account arrives with a `?startapp=ref_XXXX` code.
 *
 * This is the ONLY place a referral relationship is established, so the fraud
 * guard runs here rather than at payout time: catching a self-referral or a
 * shared-IP pair at signup keeps them out of the referral table entirely, and
 * the reasons are stored on the row so an admin can see why a reward is held.
 *
 * A blocked referral writes a FraudEvent and returns `created: false`; a
 * merely *deferred* one (account too new, no deposit yet) is still recorded,
 * because those are the normal state of a fresh referral, not fraud.
 */
export async function recordReferral(params: {
  referrerId: string;
  referredUserId: string;
}): Promise<RecordReferralResult> {
  const { referrerId, referredUserId } = params;

  const guard = await referralFraudCheck(referrerId, referredUserId).catch((err): ReferralFraudResult => {
    // A guard that cannot run must not silently create a referral.
    logger.error(
      { err: (err as Error).message, referrerId, referredUserId },
      'referral fraud check failed — referral not recorded',
    );
    return { allowed: false, reasons: ['The referral could not be verified. Please try again later.'], rewardEligible: false };
  });

  if (!guard.allowed) {
    await recordFraudEvent({
      type: 'REFERRAL_ABUSE',
      severity: 'MEDIUM',
      entityType: 'USER',
      entityId: referredUserId,
      details: { referrerId, referredUserId, reasons: guard.reasons, stage: 'signup' },
    }).catch(() => false);

    logger.warn({ referrerId, referredUserId, reasons: guard.reasons }, 'referral blocked at signup');
    return {
      created: false,
      referralId: null,
      allowed: false,
      rewardEligible: false,
      reasons: guard.reasons,
    };
  }

  // A user can only ever be referred once (`referred_user_id` is unique).
  const existing = await prisma.referral.findUnique({
    where: { referredUserId },
    select: { id: true, status: true },
  });
  if (existing) {
    return {
      created: false,
      referralId: existing.id,
      allowed: true,
      rewardEligible: false,
      reasons: guard.reasons,
    };
  }

  const referral = await prisma.referral.create({
    data: {
      referrerId,
      referredUserId,
      status: 'PENDING',
      note: guard.reasons.length ? guard.reasons.join(' ') : null,
    },
    select: { id: true },
  });

  const suspicious = guard.reasons.filter((r) => r.startsWith('Suspicious:') || r.startsWith('Flag:'));
  if (suspicious.length) {
    await recordFraudEvent({
      type: 'REFERRAL_ABUSE',
      severity: 'MEDIUM',
      entityType: 'REFERRAL',
      entityId: referral.id,
      details: { referrerId, referredUserId, reasons: suspicious, stage: 'signup' },
    }).catch(() => false);
  }

  logger.info(
    { referralId: referral.id, referrerId, referredUserId, rewardEligible: guard.rewardEligible },
    'referral recorded',
  );

  return {
    created: true,
    referralId: referral.id,
    allowed: true,
    rewardEligible: guard.rewardEligible,
    reasons: guard.reasons,
  };
}

/* ------------------------------------------------------------------
 *  Reward settlement
 * ------------------------------------------------------------------ */

/**
 * Settle ONE pending referral.
 *
 * Re-runs the fraud guard rather than trusting the signup decision: the
 * referred account may have deposited since, or the pair may only now look
 * abusive. A referral the guard refuses outright is marked REJECTED so the
 * sweep stops reconsidering it.
 */
async function settleReferral(referral: {
  id: string;
  referrerId: string;
  referredUserId: string;
}): Promise<'rewarded' | 'held' | 'rejected' | 'failed'> {
  try {
    const guard = await referralFraudCheck(referral.referrerId, referral.referredUserId);

    if (!guard.allowed) {
      await prisma.referral.update({
        where: { id: referral.id },
        data: {
          status: 'REJECTED',
          note: guard.reasons.join(' ') || 'Blocked by the referral guard',
        },
      });
      await recordFraudEvent({
        type: 'REFERRAL_ABUSE',
        severity: 'HIGH',
        entityType: 'REFERRAL',
        entityId: referral.id,
        details: { ...referral, reasons: guard.reasons, stage: 'settlement' },
      }).catch(() => false);
      return 'rejected';
    }

    if (!guard.rewardEligible) return 'held';

    const updated = await rewardReferral(referral.id);
    return updated.status === 'REWARDED' ? 'rewarded' : 'held';
  } catch (err) {
    // One bad referral must never abort the sweep for the rest.
    logger.error(
      { err: (err as Error).message, referralId: referral.id },
      'referral settlement failed',
    );
    return 'failed';
  }
}

/**
 * Pay out every pending referral that has become eligible.
 *
 * Eligibility is time- and deposit-based, so this is a SWEEP rather than an
 * event handler: it is safe to run as often as you like, and running it twice
 * changes nothing because `rewardReferral` is idempotent per referral.
 * Returns how many were actually paid.
 */
export async function rewardEligibleReferrals(limit = 200): Promise<number> {
  const pending = await prisma.referral.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: Math.max(1, Math.min(limit, 1_000)),
    select: { id: true, referrerId: true, referredUserId: true },
  });

  let rewarded = 0;
  for (const referral of pending) {
    const outcome = await settleReferral(referral);
    if (outcome === 'rewarded') rewarded += 1;
  }

  if (rewarded > 0) logger.info({ rewarded, considered: pending.length }, 'referral sweep paid rewards');
  return rewarded;
}

/**
 * Referral queue at a glance, for the ops dashboard.
 *
 * `pendingRewardsCents` is what it would cost to pay every waiting referral at
 * the current rate — the number an operator wants before running the sweep.
 */
export async function referralQueueStats(): Promise<{
  pending: number;
  rewarded: number;
  rejected: number;
  pendingRewardsCents: number;
}> {
  const [pending, rewarded, rejected, rewardCents] = await Promise.all([
    prisma.referral.count({ where: { status: 'PENDING' } }),
    prisma.referral.count({ where: { status: 'REWARDED' } }),
    prisma.referral.count({ where: { status: 'REJECTED' } }),
    businessRules.referralRewardCents(),
  ]);

  return { pending, rewarded, rejected, pendingRewardsCents: pending * rewardCents };
}

/**
 * Settle just the referral belonging to one user.
 *
 * Called right after that user's FIRST deposit is verified, so the referrer is
 * paid without waiting for the next sweep. Never throws: a referral problem
 * must not roll back a verified deposit.
 */
export async function settleReferralForUser(
  referredUserId: string,
): Promise<'rewarded' | 'held' | 'rejected' | 'failed' | 'none'> {
  try {
    const referral = await prisma.referral.findUnique({
      where: { referredUserId },
      select: { id: true, referrerId: true, referredUserId: true, status: true },
    });

    if (!referral || referral.status !== 'PENDING') return 'none';

    return await settleReferral(referral);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, referredUserId },
      'referral settlement for user failed',
    );
    return 'none';
  }
}

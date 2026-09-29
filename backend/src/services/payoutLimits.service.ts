/**
 * Payout limits and referral-fraud guardrails.
 *
 * Withdrawals — `checkWithdrawalLimits` collects EVERY failed reason (it does
 * not stop at the first):
 *   * amount is a positive integer, within min/max single withdrawal
 *     (minWithdrawalCents from ENTITLEMENTS, maxWithdrawalCents from settings)
 *   * rolling last-24h sum of non-rejected withdrawals + this one
 *     <= the user's `dailyWithdrawLimitCents` ENTITLEMENT (FREE default 2000)
 *   * rolling last-30d sum of non-rejected withdrawals + this one
 *     <= the user's `monthlyWithdrawLimitCents` ENTITLEMENT (FREE default 50000)
 *   * at most max_pending_withdrawals (default 2) withdrawals PENDING at once
 *
 *   The per-withdrawal minimum and the rolling caps come from `entitlementsFor`;
 *   a user with no active subscription resolves to the FREE baseline, so nothing
 *   here tightens or loosens a free account's existing numbers. The plan's
 *   benefits raise them for premium tiers.
 *
 * `requiresManualReview` (does not block the withdrawal) is true when ANY of:
 *   * amount >= manual_review_threshold_cents (default 2000, i.e. the free
 *     24h cap — a threshold above it could never fire for a free account)
 *   * the user has more than 3 withdrawals in the last 24h
 *   * any prior withdrawal was rejected
 *
 * `retryAfterMs` (best-effort) is set only when a time window is the blocker:
 * it is the time until the oldest withdrawal inside the failed window falls
 * out of it. Waiting cannot help for min/max/pending-cap failures, so it is
 * omitted there.
 *
 * Referrals — `allowed` is false ONLY for self-referral. Every other rule
 * either defers the reward (`rewardEligible = false`) or adds a flag reason:
 *   * self-referral                          → not allowed
 *   * account younger than
 *     min_account_age_minutes_for_ear        → reward not yet eligible
 *   * referred user has no deposit on record → reward not yet eligible
 *   * referrer > max_referrals_per_day (20)  → flag for review
 *   * shared telegramId prefix or identical  → flag as suspicious
 *     hashed IP
 */

import { prisma, type Prisma } from '../db/prisma';
import { childLogger } from '../config/logger';
import { businessRules, getNumberSetting } from './settings.service';
import { entitlementsFor } from './premium.service';
import { SETTING_KEYS } from '../config/constants';
import { formatMoney } from '../utils/money';

const log = childLogger('payout-limits');

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const MS_PER_MONTH = 30 * MS_PER_DAY;

const MAX_PENDING_DEFAULT = 2;
const REVIEW_THRESHOLD_DEFAULT_CENTS = 2_000;
const MAX_REFERRALS_PER_DAY_DEFAULT = 20;
const MIN_ACCOUNT_AGE_MINUTES_DEFAULT = 1_440;

export interface WithdrawalLimitResult {
  allowed: boolean;
  reasons: string[];
  requiresManualReview: boolean;
  retryAfterMs?: number;
}

export interface WithdrawalUsageResult {
  requestedTodayCents: number;
  paidTodayCents: number;
  pendingCount: number;
  pendingCents: number;
  dailyLimitCents: number;
  monthlyLimitCents: number;
}

export interface ReferralFraudResult {
  allowed: boolean;
  reasons: string[];
  rewardEligible: boolean;
}

interface WithdrawalWindow {
  /** Non-rejected withdrawals in the last 24h. */
  recent: Array<{ amountCents: number; createdAt: Date }>;
  /** Non-rejected withdrawals in the last 30 days. */
  monthly: Array<{ amountCents: number; createdAt: Date }>;
  paidTodayCents: number;
  withdrawalsIn24h: number;
  pendingCount: number;
  pendingCents: number;
  everRejected: boolean;
}

/**
 * The slice of the database these checks need.
 *
 * Accepting a client rather than importing the singleton is what lets the
 * withdrawal service run the limits INSIDE its own transaction, after the
 * wallet row lock — the only place where the counts cannot be raced.
 */
export type PayoutReader = Pick<Prisma.TransactionClient, 'withdrawal'>;

async function collectWithdrawalWindow(userId: string, db: PayoutReader = prisma): Promise<WithdrawalWindow> {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - MS_PER_DAY);
  const monthAgo = new Date(now.getTime() - MS_PER_MONTH);

  const [recent, monthly, paidToday, in24h, pending, rejected] = await Promise.all([
    db.withdrawal.findMany({
      where: { userId, status: { not: 'REJECTED' }, createdAt: { gte: dayAgo } },
      select: { amountCents: true, createdAt: true },
    }),
    db.withdrawal.findMany({
      where: { userId, status: { not: 'REJECTED' }, createdAt: { gte: monthAgo } },
      select: { amountCents: true, createdAt: true },
    }),
    db.withdrawal.findMany({
      where: { userId, status: 'PAID', createdAt: { gte: dayAgo } },
      select: { amountCents: true },
    }),
    db.withdrawal.findMany({
      where: { userId, createdAt: { gte: dayAgo } },
      select: { id: true },
    }),
    db.withdrawal.findMany({
      where: { userId, status: 'PENDING' },
      select: { amountCents: true },
    }),
    db.withdrawal.findFirst({
      where: { userId, status: 'REJECTED' },
      select: { id: true },
    }),
  ]);

  return {
    recent,
    monthly,
    paidTodayCents: paidToday.reduce((acc, w) => acc + w.amountCents, 0),
    withdrawalsIn24h: in24h.length,
    pendingCount: pending.length,
    pendingCents: pending.reduce((acc, w) => acc + w.amountCents, 0),
    everRejected: rejected !== null,
  };
}

/**
 * Milliseconds until the oldest row in the window falls out of it, so that
 * waiting (not a smaller amount) can free up room. Undefined when waiting
 * cannot help (window empty, or the blocker is not time-based).
 */
function msUntilOldestExits(rows: Array<{ createdAt: Date }>, windowMs: number): number | undefined {
  if (rows.length === 0) return undefined;
  const oldest = rows.reduce(
    (min, r) => (r.createdAt.getTime() < min ? r.createdAt.getTime() : min),
    rows[0].createdAt.getTime(),
  );
  const ms = oldest + windowMs - Date.now();
  return ms > 0 ? ms : undefined;
}

/**
 * Decide whether a withdrawal of `amountCents` is allowed right now.
 * Every failed check appends a plain-language sentence to `reasons`.
 */
export async function checkWithdrawalLimits(
  userId: string,
  amountCents: number,
  db: PayoutReader = prisma,
): Promise<WithdrawalLimitResult> {
  const [win, ent, maxCents, maxPending, reviewThresholdCents] = await Promise.all([
    collectWithdrawalWindow(userId, db),
    entitlementsFor(userId),
    businessRules.maxWithdrawalCents(),
    getNumberSetting(SETTING_KEYS.MAX_PENDING_WITHDRAWALS, MAX_PENDING_DEFAULT),
    getNumberSetting(SETTING_KEYS.MANUAL_REVIEW_THRESHOLD_CENTS, REVIEW_THRESHOLD_DEFAULT_CENTS),
  ]);

  // Minimum withdrawal and the rolling 24h/30d caps are ENTITLEMENT values. With
  // no active subscription they resolve to the FREE baseline (min 500, daily
  // 2000, monthly 50000) — the same numbers a free account already saw.
  const minCents = ent.minWithdrawalCents;
  const dailyLimitCents = ent.dailyWithdrawLimitCents;
  const monthlyLimitCents = ent.monthlyWithdrawLimitCents;

  const reasons: string[] = [];
  let retryAfterMs: number | undefined;
  const noteRetry = (ms: number | undefined) => {
    if (ms !== undefined) retryAfterMs = Math.max(retryAfterMs ?? 0, ms);
  };

  const validAmount = Number.isInteger(amountCents) && amountCents > 0;
  if (!validAmount) {
    reasons.push('The withdrawal amount must be a positive whole number of cents.');
  }

  if (validAmount) {
    const requestedToday = win.recent.reduce((acc, w) => acc + w.amountCents, 0);
    const requestedMonthly = win.monthly.reduce((acc, w) => acc + w.amountCents, 0);

    if (amountCents < minCents) {
      reasons.push(`This is below the minimum withdrawal of ${formatMoney(minCents)}.`);
    }
    if (amountCents > maxCents) {
      reasons.push(`This is above the maximum single withdrawal of ${formatMoney(maxCents)}.`);
    }
    if (requestedToday + amountCents > dailyLimitCents) {
      reasons.push(
        `This would put you over the ${formatMoney(dailyLimitCents)} limit for the last 24 hours; you have already requested ${formatMoney(requestedToday)} in that window.`,
      );
      noteRetry(msUntilOldestExits(win.recent, MS_PER_DAY));
    }
    if (requestedMonthly + amountCents > monthlyLimitCents) {
      reasons.push(
        `This would put you over the ${formatMoney(monthlyLimitCents)} limit for the last 30 days; you have already requested ${formatMoney(requestedMonthly)} in that window.`,
      );
      noteRetry(msUntilOldestExits(win.monthly, MS_PER_MONTH));
    }
    if (win.pendingCount >= maxPending) {
      reasons.push(
        `You already have ${win.pendingCount} withdrawal(s) pending; at most ${maxPending} may be pending at the same time.`,
      );
    }
  }

  const requiresManualReview =
    (validAmount && amountCents >= reviewThresholdCents) || win.withdrawalsIn24h > 3 || win.everRejected;

  const allowed = reasons.length === 0;
  log.info({ userId, amountCents, allowed, requiresManualReview, reasons }, 'withdrawal limits checked');

  const result: WithdrawalLimitResult = { allowed, reasons, requiresManualReview };
  if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
  return result;
}

/** Current usage against the payout limits, for dashboards. */
export async function withdrawalUsage(userId: string): Promise<WithdrawalUsageResult> {
  const [win, ent] = await Promise.all([collectWithdrawalWindow(userId), entitlementsFor(userId)]);

  return {
    requestedTodayCents: win.recent.reduce((acc, w) => acc + w.amountCents, 0),
    paidTodayCents: win.paidTodayCents,
    pendingCount: win.pendingCount,
    pendingCents: win.pendingCents,
    dailyLimitCents: ent.dailyWithdrawLimitCents,
    monthlyLimitCents: ent.monthlyWithdrawLimitCents,
  };
}

/**
 * Referral-fraud guardrails for the reward.
 *
 * `allowed` is false ONLY for self-referral. The other rules either defer the
 * reward (`rewardEligible = false`) or merely add a flag reason for review.
 */
export async function referralFraudCheck(
  referrerId: string,
  referredUserId: string,
): Promise<ReferralFraudResult> {
  const reasons: string[] = [];
  let rewardEligible = true;

  if (referrerId === referredUserId) {
    reasons.push('You cannot refer yourself.');
    log.warn({ referrerId }, 'self-referral blocked');
    return { allowed: false, reasons, rewardEligible: false };
  }

  const now = new Date();
  const dayAgo = new Date(now.getTime() - MS_PER_DAY);

  const [referrer, referred, referralsIn24h, refIps, referredIps, minAgeMinutes, maxReferralsPerDay] =
    await Promise.all([
      prisma.user.findUnique({ where: { id: referrerId }, select: { telegramId: true } }),
      prisma.user.findUnique({
        where: { id: referredUserId },
        select: { createdAt: true, telegramId: true, totalDepositedCents: true },
      }),
      prisma.referral.count({ where: { referrerId, createdAt: { gte: dayAgo } } }),
      prisma.click.findMany({
        where: { userId: referrerId, ipHash: { not: null } },
        distinct: ['ipHash'],
        select: { ipHash: true },
      }),
      prisma.click.findMany({
        where: { userId: referredUserId, ipHash: { not: null } },
        distinct: ['ipHash'],
        select: { ipHash: true },
      }),
      getNumberSetting(SETTING_KEYS.MIN_ACCOUNT_AGE_MINUTES_FOR_EAR, MIN_ACCOUNT_AGE_MINUTES_DEFAULT),
      getNumberSetting(SETTING_KEYS.MAX_REFERRALS_PER_DAY, MAX_REFERRALS_PER_DAY_DEFAULT),
    ]);

  if (!referrer) {
    reasons.push('The referrer account could not be found, so the referral cannot be processed.');
    rewardEligible = false;
  }
  if (!referred) {
    reasons.push('The referred account could not be found, so the referral reward cannot be paid.');
    rewardEligible = false;
  } else {
    const ageMinutes = (now.getTime() - referred.createdAt.getTime()) / MS_PER_MINUTE;
    if (ageMinutes < minAgeMinutes) {
      rewardEligible = false;
      reasons.push(
        `The referred account is only about ${Math.max(0, Math.floor(ageMinutes))} minutes old; it must be at least ${minAgeMinutes} minutes old before a referral reward is available.`,
      );
    }
    if (referred.totalDepositedCents <= 0) {
      rewardEligible = false;
      reasons.push(
        'The referred account has no deposit on record yet; the referral reward becomes available once a deposit is verified.',
      );
    }
  }

  if (referralsIn24h > maxReferralsPerDay) {
    reasons.push(
      `Flag: this referrer already has ${referralsIn24h} referrals in the last 24 hours, more than the ${maxReferralsPerDay} per day limit; the referral is marked for review.`,
    );
  }

  // Shared telegramId prefix: two different accounts whose Telegram IDs start
  // with the same leading digits can indicate the same person (multi-account).
  const refTg = referrer ? String(referrer.telegramId) : null;
  const referredTg = referred ? String(referred.telegramId) : null;
  if (refTg !== null && referredTg !== null && refTg !== referredTg) {
    const prefixLen = Math.min(3, refTg.length, referredTg.length);
    if (prefixLen > 0 && refTg.slice(0, prefixLen) === referredTg.slice(0, prefixLen)) {
      reasons.push(
        'Suspicious: the two accounts have Telegram user IDs that share the same leading digits, which can indicate the same person.',
      );
    }
  }

  // Identical hashed IP: both accounts clicked a tracking link from the same IP.
  const referredIpSet = new Set(
    referredIps.filter((c) => c.ipHash !== null).map((c) => c.ipHash as string),
  );
  const sharedIp = refIps.find((c) => c.ipHash !== null && referredIpSet.has(c.ipHash));
  if (sharedIp) {
    reasons.push('Suspicious: both accounts have clicked from the same hashed IP address.');
  }

  log.info({ referrerId, referredUserId, rewardEligible, reasons }, 'referral fraud check done');

  return { allowed: true, reasons, rewardEligible };
}

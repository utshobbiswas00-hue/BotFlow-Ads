import type { BillingPeriod, PlanTier, Prisma } from '@prisma/client';
import { prisma, transaction } from '../db/prisma';
import { postLedger } from './transaction.service';
import { getBoolSetting, getNumberSetting } from './settings.service';
import { SETTING_KEYS } from '../config/constants';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { recordAudit } from './audit.service';
import { logger } from '../config/logger';

/**
 * PREMIUM MEMBERSHIP
 *
 * A paid tier that lifts the free limits and unlocks abilities, the way most
 * platforms do it. Everything is data-driven: a plan's `benefits` JSON holds the
 * entitlement deltas, so pricing and perks change from the admin panel without a
 * deploy.
 *
 * The free tier is NOT a special case in code — it is expressed as the baseline
 * from settings, and a plan simply overrides the keys it cares about. That means
 * a user with no subscription still resolves through exactly the same code path.
 */

export interface Entitlements {
  maxChannels: number;
  maxActiveCampaigns: number;
  platformFeePercent: number;
  publisherEarningBonusPct: number;
  dailyWithdrawLimitCents: number;
  monthlyWithdrawLimitCents: number;
  minWithdrawalCents: number;
  maxCampaignBudgetCents: number;
  channelCooldownHours: number;
  maxCampaignsPerHour: number;
  advancedAnalytics: boolean;
  prioritySupport: boolean;
  featuredMarketplace: boolean;
  autoApproveCampaigns: boolean;
  referralBonusPercent: number;
}

export const FREE_ENTITLEMENTS: Omit<
  Entitlements,
  'maxChannels' | 'maxActiveCampaigns' | 'dailyWithdrawLimitCents' | 'minWithdrawalCents'
> = {
  platformFeePercent: 20,
  publisherEarningBonusPct: 0,
  monthlyWithdrawLimitCents: 50_000,
  maxCampaignBudgetCents: 100_000,
  channelCooldownHours: 24,
  maxCampaignsPerHour: 2,
  advancedAnalytics: false,
  prioritySupport: false,
  featuredMarketplace: false,
  autoApproveCampaigns: false,
  referralBonusPercent: 0,
};

/* ------------------------------------------------------------------
 *  Plans
 * ------------------------------------------------------------------ */

export interface PlanInput {
  code: string;
  name: string;
  description?: string;
  tier?: PlanTier;
  period?: BillingPeriod;
  priceCents: number;
  durationDays?: number;
  benefits?: Partial<Entitlements>;
  sortOrder?: number;
  isFeatured?: boolean;
  badgeText?: string;
}

export async function listPlans(activeOnly = true) {
  return prisma.subscriptionPlan.findMany({
    where: activeOnly ? { isActive: true } : {},
    orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
  });
}

export async function getPlanByCode(code: string) {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { code } });
  if (!plan) throw new NotFoundError('Plan');
  return plan;
}

export async function upsertPlan(input: PlanInput): Promise<{ id: string }> {
  if (input.priceCents < 0) throw new ValidationError('Plan price cannot be negative');
  const durationDays = input.durationDays ?? defaultDuration(input.period ?? 'MONTHLY');

  const plan = await prisma.subscriptionPlan.upsert({
    where: { code: input.code },
    create: {
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      tier: input.tier ?? 'PREMIUM',
      period: input.period ?? 'MONTHLY',
      priceCents: input.priceCents,
      durationDays,
      benefits: (input.benefits ?? {}) as never,
      sortOrder: input.sortOrder ?? 0,
      isFeatured: input.isFeatured ?? false,
      badgeText: input.badgeText ?? null,
    },
    update: {
      name: input.name,
      description: input.description ?? null,
      tier: input.tier ?? 'PREMIUM',
      period: input.period ?? 'MONTHLY',
      priceCents: input.priceCents,
      durationDays,
      benefits: (input.benefits ?? {}) as never,
      sortOrder: input.sortOrder ?? 0,
      isFeatured: input.isFeatured ?? false,
      badgeText: input.badgeText ?? null,
      isActive: true,
    },
    select: { id: true },
  });

  return plan;
}

function defaultDuration(period: BillingPeriod): number {
  switch (period) {
    case 'YEARLY':
      return 365;
    case 'QUARTERLY':
      return 90;
    case 'MONTHLY':
    default:
      return 30;
  }
}

/** Toggle a plan's visibility on the pricing page without deleting it. */
export async function setPlanActive(code: string, isActive: boolean): Promise<{ id: string; isActive: boolean }> {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { code }, select: { id: true } });
  if (!plan) throw new NotFoundError('Plan');

  return prisma.subscriptionPlan.update({
    where: { code },
    data: { isActive },
    select: { id: true, isActive: true },
  });
}

/* ------------------------------------------------------------------
 *  Entitlements
 * ------------------------------------------------------------------ */

export async function activeSubscription(userId: string) {
  return prisma.subscription.findFirst({
    where: { userId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: 'desc' },
    include: { plan: true },
  });
}

/**
 * Resolve what this user may actually do right now.
 * No subscription -> the free baseline from settings. A subscription -> the free
 * baseline with the plan's benefit keys layered on top.
 */
export async function entitlementsFor(userId: string): Promise<Entitlements> {
  const [freeChannels, freeCampaigns, freeDailyWithdraw, minWithdraw, sub] = await Promise.all([
    getNumberSetting(SETTING_KEYS.PREMIUM_FREE_MAX_CHANNELS, 3),
    getNumberSetting(SETTING_KEYS.PREMIUM_FREE_MAX_ACTIVE_CAMPAIGNS, 2),
    getNumberSetting(SETTING_KEYS.PREMIUM_FREE_DAILY_WITHDRAW_LIMIT_CENTS, 2000),
    getNumberSetting(SETTING_KEYS.MIN_WITHDRAWAL_CENTS, 500),
    activeSubscription(userId).catch(() => null),
  ]);

  const base: Entitlements = {
    ...FREE_ENTITLEMENTS,
    maxChannels: freeChannels,
    maxActiveCampaigns: freeCampaigns,
    dailyWithdrawLimitCents: freeDailyWithdraw,
    minWithdrawalCents: minWithdraw,
  };

  if (!sub) return base;

  return mergeEntitlements(base, (sub.benefits ?? {}) as Record<string, unknown>);
}

/**
 * Layer a plan's declared benefits on top of a baseline entitlement set.
 *
 * Pure and exported on purpose: the merge is the part worth testing on its own,
 * and a DB-free unit test can pin it down without standing up Postgres or Redis.
 * Only keys the base actually declares are overridden, and only when the type
 * matches — a malformed benefit value is ignored rather than corrupting the
 * entitlement set. The base object is never mutated.
 */
export function mergeEntitlements(
  base: Entitlements,
  overrides: Record<string, unknown>,
): Entitlements {
  const merged: Entitlements = { ...base };
  const writable = merged as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in merged)) continue;
    const current = merged[key as keyof Entitlements];
    if (typeof current === 'number' && typeof value === 'number') {
      writable[key] = value;
    } else if (typeof current === 'boolean' && typeof value === 'boolean') {
      writable[key] = value;
    }
  }

  return merged;
}

export interface QuotaCheck {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  message?: string;
}

/** Generic quota gate. `-1` means unlimited. */
export async function checkQuota(
  userId: string,
  kind: 'channels' | 'activeCampaigns',
): Promise<QuotaCheck> {
  const ent = await entitlementsFor(userId);

  const [used, limit] =
    kind === 'channels'
      ? [
          await prisma.channel.count({ where: { ownerId: userId, status: { not: 'REJECTED' } } }),
          ent.maxChannels,
        ]
      : [
          await prisma.campaign.count({
            where: {
              advertiserId: userId,
              status: { in: ['APPROVED', 'SCHEDULED', 'RUNNING'] },
            },
          }),
          ent.maxActiveCampaigns,
        ];

  if (limit < 0) return { allowed: true, used, limit, remaining: Number.MAX_SAFE_INTEGER };

  const remaining = Math.max(0, limit - used);
  return {
    allowed: used < limit,
    used,
    limit,
    remaining,
    ...(used >= limit
      ? {
          message:
            kind === 'channels'
              ? `Free accounts can register up to ${limit} channels. Upgrade to Premium to add more.`
              : `Free accounts can run ${limit} active campaigns. Upgrade to Premium to run more.`,
        }
      : {}),
  };
}

/* ------------------------------------------------------------------
 *  Purchase
 * ------------------------------------------------------------------ */

export interface PurchaseInput {
  userId: string;
  planCode: string;
  /** Unique reference from the payment that funded this, for idempotency. */
  paymentReference: string;
  /** Skip the wallet debit when the payment already moved the money. */
  alreadyPaid?: boolean;
}

/**
 * Activate a plan. Idempotent on `paymentReference`: replaying the same payment
 * returns the existing subscription rather than granting a second term.
 */
export async function purchaseSubscription(input: PurchaseInput): Promise<{
  subscriptionId: string;
  expiresAt: Date;
  replayed: boolean;
}> {
  const enabled = await getBoolSetting(SETTING_KEYS.PREMIUM_ENABLED, true);
  if (!enabled) throw new ConflictError('Premium is not available right now.');

  const plan = await getPlanByCode(input.planCode);
  if (!plan.isActive) throw new ConflictError('That plan is no longer available.');

  const existing = await prisma.subscription.findUnique({
    where: { paymentReference: input.paymentReference },
    select: { id: true, expiresAt: true },
  });
  if (existing) {
    return { subscriptionId: existing.id, expiresAt: existing.expiresAt, replayed: true };
  }

  const active = await activeSubscription(input.userId);

  return transaction(
    async (tx) => {
      // Extending an existing membership continues from its expiry, not from
      // today, so a user who renews early loses nothing.
      const startsAt = active && active.expiresAt > new Date() ? active.expiresAt : new Date();
      const expiresAt = new Date(startsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

      const subscription = await tx.subscription.create({
        data: {
          userId: input.userId,
          planId: plan.id,
          status: 'ACTIVE',
          tier: plan.tier,
          pricePaidCents: plan.priceCents,
          currency: plan.currency,
          benefits: plan.benefits as never,
          startedAt: new Date(),
          expiresAt,
          paymentReference: input.paymentReference,
        },
        select: { id: true, expiresAt: true },
      });

      await tx.user.update({
        where: { id: input.userId },
        data: { premiumTier: plan.tier, premiumUntil: expiresAt },
      });

      if (!input.alreadyPaid && plan.priceCents > 0) {
        await postLedger(tx, {
          userId: input.userId,
          type: 'MANUAL_ADJUSTMENT',
          amountCents: -plan.priceCents,
          reference: `subscription:${subscription.id}`,
          referenceType: 'SUBSCRIPTION_PURCHASE',
          walletDelta: { available: -plan.priceCents, totalSpent: plan.priceCents },
          description: `Premium subscription: ${plan.name}`,
        });
      }

      return { subscriptionId: subscription.id, expiresAt: subscription.expiresAt, replayed: false };
    },
    { timeout: 20_000 },
  );
}

export async function cancelSubscription(userId: string, reason?: string): Promise<void> {
  const sub = await activeSubscription(userId);
  if (!sub) throw new NotFoundError('Active subscription');

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { autoRenew: false, cancelledAt: new Date(), cancelReason: reason ?? null },
  });

  await recordAudit({
    actorId: userId,
    actorType: 'USER',
    action: 'SUBSCRIPTION_CANCELLED',
    targetType: 'SUBSCRIPTION',
    targetId: sub.id,
    newValue: { reason: reason ?? null },
  });
}

/**
 * Expire lapsed memberships. Run from the payout/scheduler worker.
 * A user's `premiumTier` is only downgraded when they have NO other active
 * subscription, so an upgrade that overlaps an old term does not strip perks.
 */
export async function expireSubscriptions(limit = 200): Promise<number> {
  const lapsed = await prisma.subscription.findMany({
    where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
    select: { id: true, userId: true },
    take: limit,
  });

  let expired = 0;
  for (const sub of lapsed) {
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } });

    const stillActive = await activeSubscription(sub.userId);
    if (!stillActive) {
      await prisma.user.update({
        where: { id: sub.userId },
        data: { premiumTier: 'FREE', premiumUntil: null },
      });
    }
    expired += 1;
  }

  if (expired) logger.info({ expired }, 'expired lapsed subscriptions');
  return expired;
}

/* ------------------------------------------------------------------
 *  Default plans
 * ------------------------------------------------------------------ */

const DEFAULT_PLANS: PlanInput[] = [
  {
    code: 'PREMIUM_MONTHLY',
    name: 'Premium — Monthly',
    description: 'More channels, more campaigns, lower fees.',
    tier: 'PREMIUM',
    period: 'MONTHLY',
    priceCents: 1300,
    sortOrder: 10,
    benefits: {
      maxChannels: 15,
      maxActiveCampaigns: 10,
      platformFeePercent: 15,
      publisherEarningBonusPct: 10,
      dailyWithdrawLimitCents: 20_000,
      monthlyWithdrawLimitCents: 200_000,
      minWithdrawalCents: 500,
      channelCooldownHours: 12,
      maxCampaignsPerHour: 4,
      advancedAnalytics: true,
      prioritySupport: true,
      featuredMarketplace: true,
      autoApproveCampaigns: true,
      referralBonusPercent: 10,
    },
  },
  {
    code: 'PREMIUM_YEARLY',
    name: 'Premium — Yearly',
    description: 'Two months free compared with monthly.',
    tier: 'PREMIUM',
    period: 'YEARLY',
    priceCents: 13000,
    sortOrder: 20,
    isFeatured: true,
    badgeText: 'Best value',
    benefits: {
      maxChannels: 15,
      maxActiveCampaigns: 10,
      platformFeePercent: 15,
      publisherEarningBonusPct: 10,
      dailyWithdrawLimitCents: 20_000,
      monthlyWithdrawLimitCents: 200_000,
      channelCooldownHours: 12,
      maxCampaignsPerHour: 4,
      advancedAnalytics: true,
      prioritySupport: true,
      featuredMarketplace: true,
      autoApproveCampaigns: true,
      referralBonusPercent: 10,
    },
  },
  {
    code: 'BUSINESS_YEARLY',
    name: 'Business — Yearly',
    description: 'For agencies running many channels and campaigns at once.',
    tier: 'BUSINESS',
    period: 'YEARLY',
    priceCents: 15000,
    sortOrder: 30,
    benefits: {
      maxChannels: -1,
      maxActiveCampaigns: -1,
      platformFeePercent: 10,
      publisherEarningBonusPct: 20,
      dailyWithdrawLimitCents: 100_000,
      monthlyWithdrawLimitCents: 1_000_000,
      minWithdrawalCents: 500,
      maxCampaignBudgetCents: 1_000_000,
      channelCooldownHours: 4,
      maxCampaignsPerHour: 10,
      advancedAnalytics: true,
      prioritySupport: true,
      featuredMarketplace: true,
      autoApproveCampaigns: true,
      referralBonusPercent: 25,
    },
  },
];

/**
 * One-time price/benefit correction for the two default Premium plans.
 *
 * `seedDefaultPlans` only creates a plan that is entirely absent, so editing
 * `DEFAULT_PLANS` above does nothing for a plan row that was already created
 * by an earlier boot — the $5/$50 Premium prices stay live in the database
 * until something explicitly updates that row. This runs once per plan: it
 * only touches a plan whose price is STILL the old default, so it fires
 * exactly once and can never undo a price an admin later sets through the
 * admin panel (`POST /api/admin/premium`).
 */
const PLAN_PRICE_CORRECTIONS: {
  code: string;
  oldPriceCents: number;
  newPriceCents: number;
  addBenefits?: Partial<Entitlements>;
}[] = [
  { code: 'PREMIUM_MONTHLY', oldPriceCents: 500, newPriceCents: 1300, addBenefits: { referralBonusPercent: 10 } },
  { code: 'PREMIUM_YEARLY', oldPriceCents: 5000, newPriceCents: 13000, addBenefits: { referralBonusPercent: 10 } },
];

async function applyPlanPriceCorrections(): Promise<number> {
  let applied = 0;
  for (const fix of PLAN_PRICE_CORRECTIONS) {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { code: fix.code } });
    if (!plan || plan.priceCents !== fix.oldPriceCents) continue; // already corrected, or an admin has since edited it
    await prisma.subscriptionPlan.update({
      where: { code: fix.code },
      data: {
        priceCents: fix.newPriceCents,
        benefits: { ...((plan.benefits ?? {}) as Record<string, unknown>), ...(fix.addBenefits ?? {}) } as never,
      },
    });
    applied += 1;
  }
  if (applied) logger.info({ applied }, 'applied one-time premium plan price corrections');
  return applied;
}

/**
 * Idempotent, and it never overwrites an admin-edited plan. Only a plan that is
 * entirely absent is created. Also applies the one-time price corrections above
 * so a stale, already-seeded plan self-heals on the next boot without a
 * manual database edit.
 */
export async function seedDefaultPlans(): Promise<number> {
  let created = 0;
  for (const plan of DEFAULT_PLANS) {
    const exists = await prisma.subscriptionPlan.findUnique({
      where: { code: plan.code },
      select: { id: true },
    });
    if (exists) continue;
    await upsertPlan(plan);
    created += 1;
  }
  await applyPlanPriceCorrections();
  return created;
}

/* ------------------------------------------------------------------
 *  Display
 * ------------------------------------------------------------------ */

export const BENEFIT_LABELS: Record<keyof Entitlements, string> = {
  maxChannels: 'Channels you can register',
  maxActiveCampaigns: 'Active campaigns at once',
  platformFeePercent: 'Platform fee',
  publisherEarningBonusPct: 'Publisher earnings bonus',
  dailyWithdrawLimitCents: 'Daily withdrawal limit',
  monthlyWithdrawLimitCents: 'Monthly withdrawal limit',
  minWithdrawalCents: 'Minimum withdrawal',
  maxCampaignBudgetCents: 'Maximum campaign budget',
  channelCooldownHours: 'Hours between ads in one channel',
  maxCampaignsPerHour: 'Campaigns per hour per channel',
  advancedAnalytics: 'Advanced analytics',
  prioritySupport: 'Priority support',
  featuredMarketplace: 'Featured in the marketplace',
  autoApproveCampaigns: 'Campaigns skip manual review',
  referralBonusPercent: 'Referral reward bonus',
};

/** Percentage-style keys, so the UI can render "15%" instead of "15". */
export const PERCENT_KEYS: Array<keyof Entitlements> = ['platformFeePercent', 'publisherEarningBonusPct', 'referralBonusPercent'];
/** Money-style keys, in cents. */
export const MONEY_KEYS: Array<keyof Entitlements> = [
  'dailyWithdrawLimitCents',
  'monthlyWithdrawLimitCents',
  'minWithdrawalCents',
  'maxCampaignBudgetCents',
];
/** Keys where a LOWER value is better, so the comparison arrow flips. */
export const LOWER_IS_BETTER_KEYS: Array<keyof Entitlements> = [
  'platformFeePercent',
  'channelCooldownHours',
  'minWithdrawalCents',
];
/** Hours-style keys. */
export const HOURS_KEYS: Array<keyof Entitlements> = ['channelCooldownHours'];

export function describeEntitlement(key: keyof Entitlements, value: number | boolean): string {
  if (typeof value === 'boolean') return value ? 'Included' : 'Not included';
  if (value < 0) return 'Unlimited';
  if (PERCENT_KEYS.includes(key)) return `${value}%`;
  if (MONEY_KEYS.includes(key)) return `$${(value / 100).toFixed(2)}`;
  if (HOURS_KEYS.includes(key)) return `${value}h`;
  return String(value);
}

export type { Entitlements as PremiumEntitlements, PlanInput as PremiumPlanInput };
export type { Prisma };

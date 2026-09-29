import { describe, expect, it, vi } from 'vitest';
import { FREE_ENTITLEMENTS, mergeEntitlements, type Entitlements } from '../../src/services/premium.service';
import { SETTING_DEFAULTS, SETTING_KEYS } from '../../src/config/constants';

/**
 * DB-FREE unit tests for the entitlement merge.
 *
 * `mergeEntitlements` is pure, but importing it pulls in premium.service's module
 * graph (Prisma client, Redis-backed settings cache). The unit test must not need
 * a live PostgreSQL or Redis, so both infrastructure modules are mocked. No query
 * is ever issued here — the merge itself touches no I/O.
 */
vi.mock('../../src/db/prisma', () => ({
  prisma: {},
  transaction: vi.fn(),
  incrementWallet: vi.fn(),
  lockWallet: vi.fn(),
}));

vi.mock('../../src/db/redis', () => ({
  redis: {},
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  cacheDel: vi.fn(async () => undefined),
  pingRedis: vi.fn(async () => false),
  createQueueConnection: vi.fn(),
  incrWindow: vi.fn(async () => 1),
  gracefulRedisShutdown: vi.fn(async () => undefined),
}));

/** Resolve a numeric settings default. */
const settingNumber = (key: string): number => SETTING_DEFAULTS[key] as number;

/**
 * The full FREE baseline, exactly as a user with no subscription resolves to it:
 * the settings-driven keys on top of the code-level `FREE_ENTITLEMENTS` shape.
 */
const FREE_BASELINE: Entitlements = {
  ...FREE_ENTITLEMENTS,
  maxChannels: settingNumber(SETTING_KEYS.PREMIUM_FREE_MAX_CHANNELS),
  maxActiveCampaigns: settingNumber(SETTING_KEYS.PREMIUM_FREE_MAX_ACTIVE_CAMPAIGNS),
  dailyWithdrawLimitCents: settingNumber(SETTING_KEYS.PREMIUM_FREE_DAILY_WITHDRAW_LIMIT_CENTS),
  monthlyWithdrawLimitCents: settingNumber(SETTING_KEYS.PREMIUM_FREE_MONTHLY_WITHDRAW_LIMIT_CENTS),
  maxCampaignBudgetCents: settingNumber(SETTING_KEYS.PREMIUM_FREE_MAX_CAMPAIGN_BUDGET_CENTS),
  channelCooldownHours: settingNumber(SETTING_KEYS.PREMIUM_FREE_CHANNEL_COOLDOWN_HOURS),
  maxCampaignsPerHour: settingNumber(SETTING_KEYS.PREMIUM_FREE_MAX_CAMPAIGNS_PER_HOUR),
  minWithdrawalCents: settingNumber(SETTING_KEYS.MIN_WITHDRAWAL_CENTS),
};

/** The exact FREE values that must never change. Hard-coded, on purpose. */
const EXPECTED_FREE: Entitlements = {
  maxChannels: 3,
  maxActiveCampaigns: 2,
  platformFeePercent: 20,
  publisherEarningBonusPct: 0,
  dailyWithdrawLimitCents: 2000,
  monthlyWithdrawLimitCents: 50_000,
  minWithdrawalCents: 500,
  maxCampaignBudgetCents: 100_000,
  channelCooldownHours: 24,
  maxCampaignsPerHour: 2,
  advancedAnalytics: false,
  prioritySupport: false,
  featuredMarketplace: false,
  autoApproveCampaigns: false,
  referralBonusPercent: 0,
};

describe('mergeEntitlements', () => {
  it('(a) returns the exact FREE baseline when there are no overrides', () => {
    // The baseline itself must resolve to today's FREE numbers...
    expect(FREE_BASELINE).toEqual(EXPECTED_FREE);
    // ...and an empty override set must be a no-op identity.
    expect(mergeEntitlements(FREE_BASELINE, {})).toEqual(EXPECTED_FREE);
  });

  it('(b) applies declared PREMIUM keys and leaves every other key untouched', () => {
    const premium = mergeEntitlements(FREE_BASELINE, {
      maxChannels: 15,
      maxActiveCampaigns: 10,
      platformFeePercent: 15,
      advancedAnalytics: true,
      prioritySupport: true,
    });

    expect(premium.maxChannels).toBe(15);
    expect(premium.maxActiveCampaigns).toBe(10);
    expect(premium.platformFeePercent).toBe(15);
    expect(premium.advancedAnalytics).toBe(true);
    expect(premium.prioritySupport).toBe(true);

    // Every key the plan did not declare keeps its FREE value.
    expect(premium).toEqual({
      ...FREE_BASELINE,
      maxChannels: 15,
      maxActiveCampaigns: 10,
      platformFeePercent: 15,
      advancedAnalytics: true,
      prioritySupport: true,
    });
  });

  it('(c) ignores malformed overrides: wrong type or a key outside the base', () => {
    const merged = mergeEntitlements(FREE_BASELINE, {
      maxChannels: 'lots', // string for a number key → ignored
      platformFeePercent: true, // boolean for a number key → ignored
      advancedAnalytics: 1, // number for a boolean key → ignored
      prioritySupport: 'yes', // string for a boolean key → ignored
      notARealEntitlement: 999, // key not in the base → ignored
    });

    expect(merged).toEqual(FREE_BASELINE);
    expect(merged.maxChannels).toBe(3);
    expect(merged.platformFeePercent).toBe(20);
    expect(merged.advancedAnalytics).toBe(false);
    expect((merged as unknown as Record<string, unknown>).notARealEntitlement).toBeUndefined();
  });

  it('(d) preserves -1, which means unlimited', () => {
    const business = mergeEntitlements(FREE_BASELINE, {
      maxChannels: -1,
      maxActiveCampaigns: -1,
      monthlyWithdrawLimitCents: -1,
    });

    expect(business.maxChannels).toBe(-1);
    expect(business.maxActiveCampaigns).toBe(-1);
    expect(business.monthlyWithdrawLimitCents).toBe(-1);
    // Anything not overridden is still the FREE value.
    expect(business.channelCooldownHours).toBe(24);
  });

  it('does not mutate the base object', () => {
    const before = { ...FREE_BASELINE };
    mergeEntitlements(FREE_BASELINE, { maxChannels: 99 });
    expect(FREE_BASELINE).toEqual(before);
  });
});

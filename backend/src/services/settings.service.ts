import { prisma } from '../db/prisma';
import { cacheGet, cacheSet, cacheDel } from '../db/redis';
import { CACHE_TTL } from '@botflow/shared';
import { SETTING_DEFAULTS, SETTING_KEYS } from '../config/constants';
import { logger } from '../config/logger';

const CACHE_KEY = 'settings:all';

export type SettingsMap = Record<string, unknown>;

/**
 * Admin-configurable settings.
 *
 * Every value resolves in this order:
 *   1. Redis cache
 *   2. `settings` table row
 *   3. code-level default from SETTING_DEFAULTS
 *
 * A missing DB row therefore never breaks a money calculation.
 */
export async function getAllSettings(useCache = true): Promise<SettingsMap> {
  if (useCache) {
    const cached = await cacheGet<SettingsMap>(CACHE_KEY);
    if (cached) return cached;
  }

  const rows = await prisma.setting.findMany();
  const merged: SettingsMap = { ...SETTING_DEFAULTS };
  for (const row of rows) merged[row.key] = row.value;

  await cacheSet(CACHE_KEY, merged, CACHE_TTL.SETTINGS);
  return merged;
}

export async function getSetting<T = unknown>(key: string): Promise<T> {
  const all = await getAllSettings();
  return (all[key] ?? SETTING_DEFAULTS[key]) as T;
}

export async function getNumberSetting(key: string, fallback = 0): Promise<number> {
  const raw = await getSetting(key);
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
  return Number.isFinite(n) ? n : fallback;
}

export async function getBoolSetting(key: string, fallback = false): Promise<boolean> {
  const raw = await getSetting(key);
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
  return fallback;
}

export async function getStringSetting(key: string, fallback = ''): Promise<string> {
  const raw = await getSetting(key);
  if (raw === null || raw === undefined) return fallback;
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

export async function getArraySetting<T = string>(key: string, fallback: T[] = []): Promise<T[]> {
  const raw = await getSetting(key);
  return Array.isArray(raw) ? (raw as T[]) : fallback;
}

export async function setSetting(
  key: string,
  value: unknown,
  updatedById?: string | null,
  meta?: { group?: string; description?: string; valueType?: string; isPublic?: boolean },
): Promise<void> {
  const valueType = meta?.valueType ?? inferType(value);

  await prisma.setting.upsert({
    where: { key },
    create: {
      key,
      value: value as never,
      valueType,
      group: meta?.group ?? inferGroup(key),
      description: meta?.description,
      isPublic: meta?.isPublic ?? false,
      updatedById: updatedById ?? null,
    },
    update: {
      value: value as never,
      valueType,
      ...(meta?.group ? { group: meta.group } : {}),
      ...(meta?.description ? { description: meta.description } : {}),
      ...(meta?.isPublic !== undefined ? { isPublic: meta.isPublic } : {}),
      updatedById: updatedById ?? null,
    },
  });

  await invalidateSettingsCache();
  logger.info({ key, updatedById }, 'setting updated');
}

export async function invalidateSettingsCache(): Promise<void> {
  await cacheDel(CACHE_KEY);
}

/**
 * Keys the Mini App is always allowed to read. Listed here rather than relying
 * only on the `isPublic` column so a fresh install with an empty settings table
 * still returns the defaults — the client should never have to hard-code a
 * fallback for something as basic as the support handle.
 */
const ALWAYS_PUBLIC_KEYS: string[] = [
  SETTING_KEYS.SUPPORT_USERNAME,
  SETTING_KEYS.MAINTENANCE_MODE,
  SETTING_KEYS.MAINTENANCE_MESSAGE,
  SETTING_KEYS.PUBLISHER_CPM_RATE_CENTS,
  SETTING_KEYS.PUBLISHER_CPM_ENABLED,
  SETTING_KEYS.PREMIUM_ENABLED,
  SETTING_KEYS.MIN_WITHDRAWAL_CENTS,
  SETTING_KEYS.MAX_WITHDRAWAL_CENTS,
  SETTING_KEYS.MIN_CAMPAIGN_BUDGET_CENTS,
  SETTING_KEYS.PLATFORM_FEE_PERCENT,
  SETTING_KEYS.ALLOWED_DEPOSIT_METHODS,
  SETTING_KEYS.MIN_WITHDRAWAL_METHODS,
];

export async function getPublicSettings(): Promise<Record<string, unknown>> {
  const all = await getAllSettings();
  const rows = await prisma.setting.findMany({ where: { isPublic: true } });

  const out: Record<string, unknown> = {};
  for (const key of ALWAYS_PUBLIC_KEYS) {
    if (all[key] !== undefined) out[key] = all[key];
  }
  for (const row of rows) out[row.key] = all[row.key];
  return out;
}

/* ----------------------------------------------------------------
 *  Typed business-rule accessors (used by wallet / campaign services)
 * ---------------------------------------------------------------- */

export const businessRules = {
  platformFeePercent: () => getNumberSetting(SETTING_KEYS.PLATFORM_FEE_PERCENT, 20),
  minWithdrawalCents: () => getNumberSetting(SETTING_KEYS.MIN_WITHDRAWAL_CENTS, 500),
  maxWithdrawalCents: () => getNumberSetting(SETTING_KEYS.MAX_WITHDRAWAL_CENTS, 100_000),
  withdrawalFeeCents: () => getNumberSetting(SETTING_KEYS.WITHDRAWAL_FEE_CENTS, 0),
  minCampaignBudgetCents: () => getNumberSetting(SETTING_KEYS.MIN_CAMPAIGN_BUDGET_CENTS, 500),
  minChannelPostPriceCents: () => getNumberSetting(SETTING_KEYS.MIN_CHANNEL_POST_PRICE_CENTS, 100),
  maxChannelPostPriceCents: () => getNumberSetting(SETTING_KEYS.MAX_CHANNEL_POST_PRICE_CENTS, 1_000_000),
  earningHoldHours: () => getNumberSetting(SETTING_KEYS.EARNING_HOLD_HOURS, 24),
  /// What a publisher EARNS per 1,000 measured views. $1.80 by default.
  publisherCpmRateCents: () => getNumberSetting(SETTING_KEYS.PUBLISHER_CPM_RATE_CENTS, 180),
  publisherCpmEnabled: () => getBoolSetting(SETTING_KEYS.PUBLISHER_CPM_ENABLED, true),
  /// What an advertiser pays per 1,000 estimated reach.
  advertiserCpmCents: () => getNumberSetting(SETTING_KEYS.ADVERTISER_CPM_CENTS, 33),
  reachFloorPercent: () => getNumberSetting(SETTING_KEYS.REACH_FLOOR_PERCENT, 83),
  reachCeilPercent: () => getNumberSetting(SETTING_KEYS.REACH_CEIL_PERCENT, 132),
  minAdvertiserBudgetCents: () => getNumberSetting(SETTING_KEYS.MIN_ADVERTISER_BUDGET_CENTS, 1000),
  paidAdSharePercent: () => getNumberSetting(SETTING_KEYS.PAID_AD_SHARE_PERCENT, 40),
  houseAdSharePercent: () => getNumberSetting(SETTING_KEYS.HOUSE_AD_SHARE_PERCENT, 60),
  houseAdPublisherSharePercent: () =>
    getNumberSetting(SETTING_KEYS.HOUSE_AD_PUBLISHER_SHARE_PERCENT, 100),
  publisherApprovalTimeoutHours: () =>
    getNumberSetting(SETTING_KEYS.PUBLISHER_APPROVAL_TIMEOUT_HOURS, 24),
  advertiserChannelCooldownHours: () =>
    getNumberSetting(SETTING_KEYS.ADVERTISER_CHANNEL_COOLDOWN_HOURS, 24),
  duplicateAdDetectionHours: () => getNumberSetting(SETTING_KEYS.DUPLICATE_AD_DETECTION_HOURS, 72),
  platformMaxAdsPerChannelPerDay: () =>
    getNumberSetting(SETTING_KEYS.PLATFORM_MAX_ADS_PER_CHANNEL_PER_DAY, 6),
  referralRewardCents: () => getNumberSetting(SETTING_KEYS.REFERRAL_REWARD_CENTS, 100),
  autoApproveCampaigns: () => getBoolSetting(SETTING_KEYS.AUTO_APPROVE_CAMPAIGNS, false),
  autoApproveChannels: () => getBoolSetting(SETTING_KEYS.AUTO_APPROVE_CHANNELS, false),
  maintenanceMode: () => getBoolSetting(SETTING_KEYS.MAINTENANCE_MODE, false),
  maintenanceMessage: () =>
    getStringSetting(SETTING_KEYS.MAINTENANCE_MESSAGE, 'BotFlow Ads is temporarily under maintenance.'),
  allowedWithdrawalMethods: () =>
    getArraySetting<string>(
      SETTING_KEYS.MIN_WITHDRAWAL_METHODS,
      SETTING_DEFAULTS[SETTING_KEYS.MIN_WITHDRAWAL_METHODS] as string[],
    ),
  allowedDepositMethods: () =>
    getArraySetting<string>(
      SETTING_KEYS.ALLOWED_DEPOSIT_METHODS,
      SETTING_DEFAULTS[SETTING_KEYS.ALLOWED_DEPOSIT_METHODS] as string[],
    ),
};

function inferType(value: unknown): string {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return 'int';
  if (typeof value === 'object') return 'json';
  return 'string';
}

function inferGroup(key: string): string {
  if (key.includes('withdraw')) return 'withdrawal';
  if (key.includes('deposit')) return 'deposit';
  if (key.includes('campaign')) return 'campaign';
  if (key.includes('channel') || key.includes('price')) return 'channel';
  if (key.includes('fee') || key.includes('revenue')) return 'revenue';
  if (key.includes('fraud') || key.includes('click')) return 'fraud';
  return 'general';
}

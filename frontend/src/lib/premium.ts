import { groupNumber, humanize } from './format';

/**
 * Shapes for the Premium API, plus the small pure helpers the UI needs.
 *
 * Every field below is supplied by a real backend route:
 *   GET  /api/premium/plans      backend/src/routes/premium.routes.ts:47
 *   GET  /api/premium/me         backend/src/routes/premium.routes.ts:96
 *   POST /api/premium/subscribe  backend/src/routes/premium.routes.ts:134
 *   POST /api/premium/cancel     backend/src/routes/premium.routes.ts:166
 *
 * Fields are optional on purpose. A deployment that is still on an older
 * backend (or a free account, where `subscription` is null) must never
 * white-screen a page, so every read site applies a `??` default.
 */

export interface PremiumPerk {
  key: string;
  label: string;
  value: unknown;
  display: string;
}

export interface PremiumPlan {
  code: string;
  name: string;
  description: string;
  tier: string;
  period: string;
  priceCents: number;
  currency: string;
  durationDays: number;
  isFeatured: boolean;
  badgeText: string | null;
  perks: PremiumPerk[];
}

/** `GET /api/premium/me` → data.subscription (null when there is no active term). */
export interface PremiumSubscription {
  id?: string;
  code?: string;
  name?: string;
  tier?: string;
  startedAt?: string | null;
  expiresAt?: string | null;
  autoRenew?: boolean;
}

/** One gate's usage. `limit < 0` means unlimited (premium.service.ts:227). */
export interface PremiumQuota {
  used: number;
  limit: number;
  remaining: number;
  allowed: boolean;
  message?: string;
}

/** The resolved entitlement set (premium.service.ts:24). Typed loosely so a
 *  plan that declares a new knob cannot break an old client. */
export interface PremiumEntitlements {
  maxChannels?: number;
  maxActiveCampaigns?: number;
  platformFeePercent?: number;
  [key: string]: unknown;
}

export interface PremiumMe {
  subscription: PremiumSubscription | null;
  tier: string;
  entitlements: PremiumEntitlements;
  quotas: {
    channels?: PremiumQuota;
    campaigns?: PremiumQuota;
  };
}

export interface PremiumCurrent {
  code: string;
  name: string;
  expiresAt: string | null;
  autoRenew: boolean;
}

export interface PremiumPlansResponse {
  enabled: boolean;
  plans: PremiumPlan[];
  current: PremiumCurrent | null;
  entitlements: PremiumEntitlements | null;
}

export interface PremiumSubscribeResponse {
  subscriptionId?: string;
  expiresAt?: string | null;
  /** true when this exact payment had already been applied. */
  replayed?: boolean;
  entitlements?: PremiumEntitlements;
}

export const FREE_TIER = 'FREE';

/** True when the caller holds a live paid term. */
export function isPremiumActive(me?: PremiumMe | null): boolean {
  const tier = (me?.tier ?? '').trim().toUpperCase();
  return Boolean(me?.subscription) || (tier !== '' && tier !== FREE_TIER);
}

/** "PREMIUM" -> "Premium", null -> "Free". */
export function tierLabel(tier?: string | null): string {
  return humanize((tier ?? FREE_TIER).trim() || FREE_TIER);
}

/** A limit for display: `-1` is the backend's "unlimited" sentinel. */
export function limitDisplay(limit?: number | null): string {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return '—';
  return limit < 0 ? 'Unlimited' : groupNumber(limit);
}

/** "unlimited channels" / "up to 3 channels" — for the live-limits sentence. */
export function limitPhrase(limit: number | undefined, noun: string): string {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return `— ${noun}s`;
  if (limit < 0) return `unlimited ${noun}s`;
  return `up to ${groupNumber(limit)} ${noun}${limit === 1 ? '' : 's'}`;
}

/**
 * Coerce one quota block into the full shape, or null when it is absent.
 * Older deployments returned no `quotas` at all; a missing gate must simply
 * hide the meter rather than render "NaN left".
 */
export function normaliseQuota(q?: Partial<PremiumQuota> | null): PremiumQuota | null {
  if (!q || typeof q !== 'object' || typeof q.limit !== 'number' || !Number.isFinite(q.limit)) {
    return null;
  }
  const limit = q.limit;
  const used = typeof q.used === 'number' && Number.isFinite(q.used) ? q.used : 0;
  const remaining =
    typeof q.remaining === 'number' && Number.isFinite(q.remaining)
      ? q.remaining
      : limit < 0
        ? -1
        : Math.max(0, limit - used);
  return {
    used,
    limit,
    remaining,
    allowed: typeof q.allowed === 'boolean' ? q.allowed : limit < 0 || used < limit,
    ...(typeof q.message === 'string' && q.message ? { message: q.message } : {}),
  };
}

/** "0 of 3 used · 3 left" / "-1" -> "5 used · Unlimited". */
export function quotaUsageText(q: PremiumQuota): string {
  if (q.limit < 0) return `${groupNumber(q.used)} used · Unlimited`;
  return `${groupNumber(q.used)} of ${groupNumber(q.limit)} used · ${groupNumber(Math.max(0, q.remaining))} left`;
}

/** True when this gate has no room left. */
export function quotaAtLimit(q: PremiumQuota | null): boolean {
  return Boolean(q && q.limit >= 0 && q.remaining <= 0);
}

/** Entitlements as numbers, with no invented defaults (undefined stays undefined). */
export function entitlementsOf(me?: PremiumMe | null): PremiumEntitlements {
  return me?.entitlements ?? {};
}

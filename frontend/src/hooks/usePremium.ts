import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { PremiumMe, PremiumPlansResponse, PremiumQuota } from '../lib/premium';
import { normaliseQuota } from '../lib/premium';

/**
 * Read-only Premium reads, shared by every page that shows a benefit.
 *
 * `GET /api/premium/me` is the canonical "what may I do right now" endpoint
 * (backend/src/routes/premium.routes.ts:96): it resolves the caller's tier,
 * expiry, entitlements and live channel/campaign usage in one request. It
 * answers for free accounts too, so a subscriber check never has to special-case
 * the free tier.
 */

export const premiumKeys = {
  plans: ['premium', 'plans'] as const,
  me: ['premium', 'me'] as const,
};

/** The signed-in user's membership + live limits. */
export function usePremiumMe(enabled = true) {
  return useQuery({
    queryKey: premiumKeys.me,
    enabled,
    queryFn: (): Promise<PremiumMe> => api.get<PremiumMe>('/api/premium/me'),
  });
}

/** The plan catalogue (public — the caller's context rides along when signed in). */
export function usePremiumPlans() {
  return useQuery({
    queryKey: premiumKeys.plans,
    queryFn: (): Promise<PremiumPlansResponse> => api.get<PremiumPlansResponse>('/api/premium/plans'),
  });
}

/** The channel gate, or null when the backend did not report it. */
export function channelsQuota(me?: PremiumMe | null): PremiumQuota | null {
  return normaliseQuota(me?.quotas?.channels);
}

/** The active-campaign gate, or null when the backend did not report it. */
export function campaignsQuota(me?: PremiumMe | null): PremiumQuota | null {
  return normaliseQuota(me?.quotas?.campaigns);
}

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { PAGINATION, type CampaignSummary, type Paginated } from '@botflow/shared';
import { api } from '../lib/api';
import type { CampaignDetail, MarketplaceFilters } from '../lib/contracts';
import type { MarketplaceChannel } from '@botflow/shared';
import { qk } from '../lib/queryClient';

/** Advertiser's campaigns with Load-more pagination (GET /api/campaigns). */
export function useCampaigns(status?: string, limit?: number) {
  const lim = limit ?? PAGINATION.DEFAULT_LIMIT;
  return useInfiniteQuery({
    queryKey: [...qk.campaigns, { status: status ?? 'all', limit: lim }],
    queryFn: ({ pageParam }): Promise<Paginated<CampaignSummary>> =>
      api.get<Paginated<CampaignSummary>>('/api/campaigns', {
        page: pageParam,
        limit: lim,
        ...(status && status !== 'all' ? { status } : {}),
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });
}

/** Single campaign detail (GET /api/campaigns/:id). */
export function useCampaign(id: string | undefined, enabled: boolean = true) {
  return useQuery({
    queryKey: qk.campaign(id ?? ''),
    enabled: enabled && !!id,
    queryFn: (): Promise<CampaignDetail> => api.get<CampaignDetail>(`/api/campaigns/${id}`),
  });
}

/** Public marketplace (GET /api/marketplace) with filters + Load more. */
export function useMarketplace(filters: MarketplaceFilters, limit?: number) {
  const lim = limit ?? PAGINATION.DEFAULT_LIMIT;
  return useInfiniteQuery({
    queryKey: [...qk.marketplace, filters, lim],
    queryFn: ({ pageParam }): Promise<Paginated<MarketplaceChannel>> =>
      api.get<Paginated<MarketplaceChannel>>('/api/marketplace', {
        page: pageParam,
        limit: lim,
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.country ? { country: filters.country } : {}),
        ...(filters.language ? { language: filters.language } : {}),
        ...(filters.minSubs ? { minSubs: filters.minSubs } : {}),
        ...(filters.maxSubs ? { maxSubs: filters.maxSubs } : {}),
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });
}

/** Invalidate campaign list + detail caches after mutations. */
export function useInvalidateCampaigns() {
  const qc = useQueryClient();
  return (): void => {
    void qc.invalidateQueries({ queryKey: qk.campaigns });
  };
}

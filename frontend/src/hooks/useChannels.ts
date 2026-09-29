import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { PAGINATION, type ChannelSummary, type Paginated } from '@botflow/shared';
import { api } from '../lib/api';
import type { BlocklistResponse, ChannelDetail } from '../lib/contracts';
import { qk } from '../lib/queryClient';

export interface ChannelListParams {
  status?: string;
  limit?: number;
}

/**
 * Publisher's own channels with Load-more pagination (GET /api/channels).
 */
export function useChannels(params: ChannelListParams = {}) {
  const limit = params.limit ?? PAGINATION.DEFAULT_LIMIT;
  return useInfiniteQuery({
    queryKey: [...qk.channels, { status: params.status ?? 'all', limit }],
    queryFn: ({ pageParam }): Promise<Paginated<ChannelSummary>> =>
      api.get<Paginated<ChannelSummary>>('/api/channels', {
        page: pageParam,
        limit,
        ...(params.status && params.status !== 'all' ? { status: params.status } : {}),
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });
}

/** Single channel detail (GET /api/channels/:id). */
export function useChannel(id: string | undefined, enabled: boolean = true) {
  return useQuery({
    queryKey: qk.channel(id ?? ''),
    enabled: enabled && !!id,
    queryFn: (): Promise<ChannelDetail> => api.get<ChannelDetail>(`/api/channels/${id}`),
  });
}

/**
 * Publisher blocklist for one channel (GET /api/channels/:id/blocklist).
 * Entries are newest-first; `summary` carries per-scope counts.
 */
export function useChannelBlocklist(id: string | undefined, enabled: boolean = true) {
  return useQuery({
    queryKey: qk.channelBlocklist(id ?? ''),
    enabled: enabled && !!id,
    queryFn: (): Promise<BlocklistResponse> => api.get<BlocklistResponse>(`/api/channels/${id}/blocklist`),
  });
}

/** Invalidate channel list + detail caches after mutations. */
export function useInvalidateChannels() {
  const qc = useQueryClient();
  return (): void => {
    void qc.invalidateQueries({ queryKey: qk.channels });
  };
}

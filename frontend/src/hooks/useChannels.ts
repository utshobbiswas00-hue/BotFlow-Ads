import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/**
 * What the bot's rights currently are inside one channel.
 * `POST /api/channels/:id/verify` — owner only.
 */
export interface ChannelVerifyResult {
  channelId: string;
  status: string;
  botIsAdmin: boolean;
  canPostMessages: boolean;
  canEditMessages: boolean;
  canDeleteMessages: boolean;
  permissionLost: boolean;
}

/**
 * Ask the backend to re-read the bot's rights from Telegram for one channel.
 *
 * The panel renders the STORED snapshot, and only two things rewrite it: Telegram's
 * `my_chat_member` push — which needs a correctly registered webhook — and a call to this
 * endpoint. `permission.worker` sweeps APPROVED channels, so a channel whose owner has just
 * granted access has nothing else to refresh it. That is why the "Open access" banner could
 * stay on screen after the bot had been made an administrator: the panel kept re-reading a
 * snapshot nobody had updated. This is the call that settles it — it reads Telegram
 * directly, and promotes the channel (PENDING/ATTENTION_REQUIRED → APPROVED) once the
 * rights are really there.
 */
export function useVerifyChannel(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<ChannelVerifyResult> =>
      api.post<ChannelVerifyResult>(`/api/channels/${id}/verify`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.channels });
      void qc.invalidateQueries({ queryKey: qk.channel(id ?? '') });
    },
  });
}

/** Invalidate channel list + detail caches after mutations. */
export function useInvalidateChannels() {
  const qc = useQueryClient();
  return (): void => {
    void qc.invalidateQueries({ queryKey: qk.channels });
  };
}

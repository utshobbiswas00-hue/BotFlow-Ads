import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Paginated } from '@botflow/shared';
import { ApiError, api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import type { NotificationRow } from '../lib/contracts';
import { fromNow } from '../lib/format';
import { PageHeader } from '../components/layout/PageHeader';
import { showToast } from '../store/uiStore';
import { Button } from '../components/ui/Button';
import { Tabs } from '../components/ui/Tabs';
import { EmptyState, ErrorState, LoadMore } from '../components/ui/EmptyState';
import { ListSkeleton } from '../components/ui/Skeleton';
import { cn } from '../lib/cn';

const CATEGORIES = ['All', 'Campaign', 'Earnings', 'Wallet', 'Channel', 'Security', 'Support'] as const;
type Category = (typeof CATEGORIES)[number];

const PAGE_SIZE = 20;

/**
 * Derive a human category from the raw notification `type`.
 * Prefers a server-provided `category` when present, otherwise maps by prefix.
 */
export function deriveCategory(row: NotificationRow): Category {
  if (row.category) {
    const c = row.category.trim();
    if (CATEGORIES.includes(c as Category)) return c as Category;
    const lower = c.toLowerCase();
    if (lower.startsWith('campaign')) return 'Campaign';
    if (lower.startsWith('earn') || lower === 'ad_published') return 'Earnings';
    if (lower.startsWith('deposit') || lower.startsWith('withdrawal') || lower.startsWith('wallet')) return 'Wallet';
    if (lower.startsWith('channel')) return 'Channel';
    if (lower === 'fraud_alert' || lower.startsWith('security')) return 'Security';
  }
  const t = row.type;
  if (
    t.startsWith('CAMPAIGN') ||
    t === 'BUDGET_LOW' ||
    t === 'NEW_AD_REQUEST' ||
    t === 'DELIVERY_FAILED'
  ) {
    return 'Campaign';
  }
  if (t.startsWith('EARNINGS') || t === 'AD_PUBLISHED') return 'Earnings';
  if (t.startsWith('DEPOSIT') || t.startsWith('WITHDRAWAL')) return 'Wallet';
  if (t.startsWith('CHANNEL')) return 'Channel';
  if (t === 'FRAUD_ALERT') return 'Security';
  return 'Support';
}

export function NotificationsPage() {
  const qc = useQueryClient();
  const [category, setCategory] = useState<Category>('All');

  const query = useInfiniteQuery({
    queryKey: [...qk.notifications, 'list', category],
    queryFn: ({ pageParam }): Promise<Paginated<NotificationRow>> =>
      api.get<Paginated<NotificationRow>>('/api/notifications', {
        page: pageParam,
        limit: PAGE_SIZE,
        ...(category !== 'All' ? { category } : {}),
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });

  const all = useMemo(
    () => (query.data ? query.data.pages.flatMap((p) => p.items) : []),
    [query.data],
  );
  const items = useMemo(
    () => (category === 'All' ? all : all.filter((n) => deriveCategory(n) === category)),
    [all, category],
  );
  const hasUnread = items.some((n) => !n.isRead);

  const markRead = useMutation({
    mutationFn: (ids: string[]): Promise<unknown> => api.post('/api/notifications/read', { ids }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.notifications }),
    onError: (e) => showToast('error', errMsg(e)),
  });

  const markAll = useMutation({
    mutationFn: (): Promise<unknown> => api.post('/api/notifications/read-all'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.notifications }),
  });

  const tap = (n: NotificationRow): void => {
    if (!n.isRead) markRead.mutate([n.id]);
  };

  const is404 = query.error instanceof ApiError && query.error.status === 404;

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Everything about your ads, channels and wallet"
        actions={
          hasUnread ? (
            <Button
              size="sm"
              variant="ghost"
              loading={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />

      <Tabs
        className="mt-2 -mx-4 px-4"
        items={CATEGORIES.map((c) => ({ value: c, label: c }))}
        value={category}
        onChange={(v) => setCategory(v as Category)}
      />

      <div className="mt-3">
        {query.isPending ? (
          <ListSkeleton rows={5} />
        ) : query.isError ? (
          is404 ? (
            <EmptyState
              icon="bell"
              title="Notifications unavailable"
              message="You have no notifications to show right now."
            />
          ) : (
            <ErrorState message={errMsg(query.error)} onRetry={() => void query.refetch()} />
          )
        ) : items.length === 0 ? (
          <EmptyState
            icon="bell"
            title="You're all caught up"
            message={category === 'All' ? 'Nothing here yet — updates will land in this inbox.' : `No ${category.toLowerCase()} notifications yet.`}
          />
        ) : (
          <>
            <div className="space-y-2">
              {items.map((n) => (
                <NotificationCard key={n.id} row={n} onOpen={() => tap(n)} />
              ))}
            </div>
            <LoadMore
              hasMore={query.hasNextPage ?? false}
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            />
          </>
        )}
      </div>
    </>
  );
}

function NotificationCard({ row, onOpen }: { row: NotificationRow; onOpen: () => void }) {
  const unread = !row.isRead;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'w-full text-left rounded-2xl border p-3.5 flex items-start gap-3 transition-colors active:opacity-80',
        unread ? 'bg-surface border-accent/30' : 'bg-app border-line',
      )}
    >
      <span
        className={cn('mt-1.5 w-2 h-2 rounded-full shrink-0', unread ? 'bg-accent' : 'bg-line')}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm leading-snug', unread ? 'font-semibold' : 'font-medium')}>{row.title}</p>
        {row.body && <p className="text-xs text-mute mt-1 line-clamp-2">{row.body}</p>}
        <p className="text-[11px] text-mute/70 mt-1.5">{fromNow(row.createdAt)}</p>
      </div>
    </button>
  );
}

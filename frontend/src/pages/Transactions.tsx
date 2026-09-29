import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { PAGINATION, type Paginated, type TransactionRow } from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { TransactionRow as TransactionRowView } from '../components/domain/TransactionRow';
import { PageHeader } from '../components/layout/PageHeader';
import { Tabs } from '../components/ui/Tabs';
import { EmptyState, ErrorState, LoadMore } from '../components/ui/EmptyState';
import { ListSkeleton } from '../components/ui/Skeleton';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'DEPOSIT', label: 'Deposits' },
  { value: 'WITHDRAWAL', label: 'Withdrawals' },
  { value: 'PUBLISHER_EARNING', label: 'Earnings' },
  { value: 'CAMPAIGN_CHARGE', label: 'Spend' },
  { value: 'REFUND', label: 'Refunds' },
  { value: 'ESCROW_HOLD', label: 'Escrow' },
  { value: 'REFERRAL_REWARD', label: 'Referrals' },
  { value: 'PLATFORM_FEE', label: 'Fees' },
  { value: 'MANUAL_ADJUSTMENT', label: 'Adjustments' },
];

export function TransactionsPage() {
  const [filter, setFilter] = useState('all');
  const type = filter === 'all' ? undefined : filter;

  const q = useInfiniteQuery({
    queryKey: ['transactions', { type: type ?? 'all' }],
    queryFn: ({ pageParam }): Promise<Paginated<TransactionRow>> =>
      api.get<Paginated<TransactionRow>>('/api/transactions', {
        page: pageParam,
        limit: PAGINATION.DEFAULT_LIMIT,
        ...(type ? { type } : {}),
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title="Transactions" subtitle="Full history of your money movements" />
      <Tabs items={FILTERS} value={filter} onChange={setFilter} className="mt-2" />

      <div className="mt-3">
        {q.isPending ? (
          <ListSkeleton rows={5} />
        ) : q.isError ? (
          <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon="wallet" title="No transactions" message="Deposits, earnings and payouts will show up here." />
        ) : (
          <>
            <div className="space-y-3">
              {items.map((t) => (
                <TransactionRowView key={t.id} row={t} />
              ))}
            </div>
            <LoadMore hasMore={q.hasNextPage ?? false} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
          </>
        )}
      </div>
    </>
  );
}

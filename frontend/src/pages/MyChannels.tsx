import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useChannels } from '../hooks/useChannels';
import { channelsQuota, usePremiumMe } from '../hooks/usePremium';
import { errMsg } from '../lib/api';
import { quotaAtLimit } from '../lib/premium';
import { ChannelCard } from '../components/domain/ChannelCard';
import { LimitUpgradePrompt, QuotaMeter } from '../components/domain/PremiumUI';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Tabs } from '../components/ui/Tabs';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState, LoadMore } from '../components/ui/EmptyState';
import { ListSkeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'INACTIVE', label: 'Inactive' },
];

export function MyChannelsPage() {
  const [filter, setFilter] = useState('all');
  const status = filter === 'all' ? undefined : filter;
  const q = useChannels({ status, limit: 15 });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  /* How many channel slots are left, straight from GET /api/premium/me.
     Null on an older backend or a failed read — the list still renders. */
  const premium = usePremiumMe();
  const quota = channelsQuota(premium.data);
  const atLimit = quotaAtLimit(quota);

  return (
    <>
      <PageHeader
        title="My channels"
        subtitle={`${items.length} connected`}
        actions={
          <Link to="/channels/new">
            <Button size="sm" icon={<Icon name="plus" size={16} />}>
              Add
            </Button>
          </Link>
        }
      />
      <Tabs items={FILTERS} value={filter} onChange={setFilter} className="mt-2" />

      {quota && (
        <Card className="mt-3">
          <QuotaMeter label="Channels you can register" quota={quota} />
        </Card>
      )}

      {atLimit && (
        <LimitUpgradePrompt
          className="mt-3"
          title="You have used every channel slot"
          message={
            quota?.message ??
            'Your plan has no channel slots left. Premium raises the limit so you can keep adding channels.'
          }
        />
      )}

      <div className="mt-3">
        {q.isPending ? (
          <ListSkeleton rows={4} />
        ) : q.isError ? (
          <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon="channel"
            title="No channels yet"
            message="Connect your Telegram channel to start earning from sponsored posts."
            action={
              <Link to="/channels/new" className="mt-1">
                <Button size="sm" icon={<Icon name="plus" size={15} />}>
                  Add channel
                </Button>
              </Link>
            }
          />
        ) : (
          <>
            <div className="space-y-3">
              {items.map((c) => (
                <ChannelCard key={c.id} channel={c} showStatus />
              ))}
            </div>
            <LoadMore hasMore={q.hasNextPage ?? false} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
          </>
        )}
      </div>
    </>
  );
}

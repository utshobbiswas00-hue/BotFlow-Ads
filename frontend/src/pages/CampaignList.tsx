import { useState } from 'react';
import { useCampaigns } from '../hooks/useCampaigns';
import { errMsg } from '../lib/api';
import { CampaignCard } from '../components/domain/CampaignCard';
import { PageHeader } from '../components/layout/PageHeader';
import { Tabs } from '../components/ui/Tabs';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState, LoadMore } from '../components/ui/EmptyState';
import { ListSkeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';
import { Link } from 'react-router-dom';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'PENDING_REVIEW', label: 'In review' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export function CampaignListPage() {
  const [filter, setFilter] = useState('all');
  const status = filter === 'all' ? undefined : filter;
  const q = useCampaigns(status, 15);

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Campaigns"
        actions={
          <Link to="/advertise/new">
            <Button size="sm" icon={<Icon name="plus" size={16} />}>
              New
            </Button>
          </Link>
        }
      />
      <Tabs items={FILTERS} value={filter} onChange={setFilter} className="mt-2" />

      <div className="mt-3">
        {q.isPending ? (
          <ListSkeleton rows={4} />
        ) : q.isError ? (
          <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon="megaphone"
            title="No campaigns here"
            message="Create a sponsored-post campaign to get started."
            action={
              <Link to="/advertise/new" className="mt-1">
                <Button size="sm" icon={<Icon name="plus" size={15} />}>
                  Create campaign
                </Button>
              </Link>
            }
          />
        ) : (
          <>
            <div className="space-y-3">
              {items.map((c) => (
                <CampaignCard key={c.id} campaign={c} />
              ))}
            </div>
            <LoadMore hasMore={q.hasNextPage ?? false} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
          </>
        )}
      </div>
    </>
  );
}

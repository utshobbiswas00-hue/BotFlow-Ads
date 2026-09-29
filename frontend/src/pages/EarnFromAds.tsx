import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ChannelSummary, Paginated, PublisherAnalytics } from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import { formatMoney } from '../lib/format';
import { useUserStore } from '../store/userStore';
import { BalanceCard } from '../components/domain/BalanceCard';
import { ChannelCard } from '../components/domain/ChannelCard';
import { StatCard } from '../components/charts/StatCard';
import { Card, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { ErrorState } from '../components/ui/EmptyState';
import { ListSkeleton, Skeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';

export function EarnFromAdsPage() {
  const wallet = useUserStore((s) => s.wallet);

  const pub = useQuery({
    queryKey: qk.analyticsPub,
    queryFn: (): Promise<PublisherAnalytics> => api.get<PublisherAnalytics>('/api/analytics/publisher'),
  });

  const channels = useQuery({
    queryKey: [...qk.channels, { status: 'all', limit: 5 }],
    queryFn: (): Promise<Paginated<ChannelSummary>> =>
      api.get<Paginated<ChannelSummary>>('/api/channels', { page: 1, limit: 5 }),
  });

  const myChannels = channels.data?.items.slice(0, 3) ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Earn from ads</h1>
        <p className="text-sm text-mute">Get paid for sponsored posts on your channels.</p>
      </div>

      {wallet && <BalanceCard wallet={wallet} />}

      <Card className="bg-gradient-to-br from-accent to-accent/80 border-0">
        <div className="flex items-start gap-3">
          <span className="w-11 h-11 rounded-2xl bg-white/15 text-white flex items-center justify-center shrink-0">
            <Icon name="coin" size={22} />
          </span>
          <div className="flex-1">
            <h2 className="text-white font-bold text-base leading-snug">Start earning today</h2>
            <p className="text-white/80 text-sm mt-1">
              Connect your Telegram channel, set your price and receive paid sponsorship
              requests. Earnings sit in a 24h hold before payout.
            </p>
            <Link to="/channels/new" className="inline-block mt-3">
              <span className="inline-flex items-center gap-1.5 h-10 px-5 rounded-xl bg-white text-accent text-sm font-semibold">
                <Icon name="plus" size={16} /> Add my channel
              </span>
            </Link>
          </div>
        </div>
      </Card>

      <div>
        <CardTitle>Your publisher stats</CardTitle>
        {pub.isLoading ? (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : pub.isError ? (
          <ErrorState message={errMsg(pub.error)} onRetry={() => void pub.refetch()} />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="Total earnings"
              value={formatMoney(pub.data!.totalEarningsCents)}
              icon={<Icon name="coin" size={16} />}
            />
            <StatCard
              label="Sponsored posts"
              value={String(pub.data!.sponsoredPosts)}
              icon={<Icon name="doc" size={16} />}
            />
            <StatCard
              label="Total views"
              value={pub.data!.totalViews.toLocaleString()}
              icon={<Icon name="eye" size={16} />}
            />
            <StatCard
              label="Total clicks"
              value={pub.data!.totalClicks.toLocaleString()}
              icon={<Icon name="target" size={16} />}
            />
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-mute uppercase tracking-wide">Earning channels</h3>
          <Link to="/channels" className="text-sm text-link font-medium">
            View all
          </Link>
        </div>
        {channels.isLoading ? (
          <ListSkeleton rows={3} />
        ) : channels.isError ? (
          <ErrorState message={errMsg(channels.error)} onRetry={() => void channels.refetch()} />
        ) : myChannels.length === 0 ? (
          <Card>
            <p className="text-sm text-mute text-center py-4">
              No channels yet — add your first channel to start earning.
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {myChannels.map((c) => (
              <ChannelCard key={c.id} channel={c} showStatus />
            ))}
          </div>
        )}
        {myChannels.length > 0 && (
          <div className="mt-3">
            <Link to="/channels">
              <Button full variant="secondary">
                Manage all channels
              </Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

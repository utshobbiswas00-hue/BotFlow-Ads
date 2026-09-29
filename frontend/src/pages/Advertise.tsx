import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { AnalyticsSummary } from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import { formatMoney } from '../lib/format';
import { useCampaigns } from '../hooks/useCampaigns';
import { CampaignCard } from '../components/domain/CampaignCard';
import { StatCard } from '../components/charts/StatCard';
import { Card, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { ErrorState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';

export function AdvertisePage() {
  const adv = useQuery({
    queryKey: qk.analyticsAdv,
    queryFn: (): Promise<AnalyticsSummary> => api.get<AnalyticsSummary>('/api/analytics/advertiser'),
  });
  const campaigns = useCampaigns(undefined, 10);
  const recent = campaigns.data?.pages.flatMap((p) => p.items).slice(0, 5) ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Advertise</h1>
        <p className="text-sm text-mute">
          Reach Telegram audiences with sponsored posts in minutes.
        </p>
      </div>

      {/* Hero CTA */}
      <Card className="bg-gradient-to-br from-accent to-accent/80 border-0">
        <div className="flex items-start gap-3">
          <span className="w-11 h-11 rounded-2xl bg-white/15 text-white flex items-center justify-center shrink-0">
            <Icon name="megaphone" size={22} />
          </span>
          <div className="flex-1">
            <h2 className="text-white font-bold text-base leading-snug">
              Launch a sponsored-post campaign
            </h2>
            <p className="text-white/80 text-sm mt-1">
              Pick your target channels, set a budget and we handle delivery, approvals and
              reporting.
            </p>
            <Link to="/advertise/new" className="inline-block mt-3">
              <span className="inline-flex items-center gap-1.5 h-10 px-5 rounded-xl bg-white text-accent text-sm font-semibold">
                <Icon name="plus" size={16} /> Create campaign
              </span>
            </Link>
          </div>
        </div>
      </Card>

      {/* Performance */}
      <div>
        <CardTitle>Your results</CardTitle>
        {adv.isLoading ? (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : adv.isError ? (
          <ErrorState message={errMsg(adv.error)} onRetry={() => void adv.refetch()} />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="Total spend"
              value={formatMoney(adv.data!.totalSpendCents)}
              icon={<Icon name="wallet" size={16} />}
            />
            <StatCard
              label="Posts published"
              value={String(adv.data!.totalPosts)}
              icon={<Icon name="doc" size={16} />}
            />
            <StatCard
              label="Views"
              value={adv.data!.totalViews.toLocaleString()}
              icon={<Icon name="eye" size={16} />}
            />
            <StatCard
              label="Clicks · CTR"
              value={`${adv.data!.totalClicks.toLocaleString()}`}
              sub={`${adv.data!.ctr.toFixed(2)}% CTR`}
              icon={<Icon name="target" size={16} />}
            />
            <StatCard
              label="Active channels"
              value={String(adv.data!.activeChannels)}
              icon={<Icon name="channel" size={16} />}
            />
            <StatCard
              label="Remaining budget"
              value={formatMoney(adv.data!.remainingBudgetCents)}
              icon={<Icon name="coin" size={16} />}
            />
          </div>
        )}
      </div>

      {/* Recent campaigns */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-mute uppercase tracking-wide">Your campaigns</h3>
          <Link to="/campaigns" className="text-sm text-link font-medium">
            View all
          </Link>
        </div>
        {campaigns.isLoading ? (
          <Skeleton className="h-24 w-full rounded-2xl" />
        ) : campaigns.isError ? (
          <ErrorState message={errMsg(campaigns.error)} onRetry={() => void campaigns.refetch()} />
        ) : recent.length === 0 ? (
          <Card>
            <p className="text-sm text-mute text-center py-4">
              No campaigns yet — start with your first sponsored post.
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {recent.map((c) => (
              <CampaignCard key={c.id} campaign={c} />
            ))}
          </div>
        )}
        {recent.length > 0 && (
          <div className="mt-3">
            <Link to="/campaigns">
              <Button full variant="secondary">
                See all campaigns
              </Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

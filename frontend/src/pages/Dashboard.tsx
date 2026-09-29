import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AnalyticsSummary, Paginated } from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import type { DashboardResponse, NotificationRow, UnreadCount } from '../lib/contracts';
import { formatDateTime, formatMoney } from '../lib/format';
import { useCampaigns } from '../hooks/useCampaigns';
import { usePremiumMe } from '../hooks/usePremium';
import { useUserStore } from '../store/userStore';
import { showToast } from '../store/uiStore';
import { BalanceCard } from '../components/domain/BalanceCard';
import { CampaignCard } from '../components/domain/CampaignCard';
import { PremiumBadge } from '../components/domain/PremiumUI';
import { StatCard } from '../components/charts/StatCard';
import { Card, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { ErrorState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { Icon, type IconName } from '../components/ui/icons';

function QuickAction({ to, icon, label }: { to: string; icon: IconName; label: string }) {
  return (
    <Link
      to={to}
      className="bg-surface border border-line rounded-2xl p-3.5 flex flex-col items-center gap-2 active:opacity-80"
    >
      <span className="w-10 h-10 rounded-xl bg-accent/10 text-accent flex items-center justify-center">
        <Icon name={icon} size={20} />
      </span>
      <span className="text-xs font-medium text-center">{label}</span>
    </Link>
  );
}

export function DashboardPage() {
  const user = useUserStore((s) => s.user);
  const qc = useQueryClient();

  const dash = useQuery({
    queryKey: qk.dashboard,
    queryFn: (): Promise<DashboardResponse> => api.get<DashboardResponse>('/api/dashboard'),
  });

  const adv = useQuery({
    queryKey: qk.analyticsAdv,
    queryFn: (): Promise<AnalyticsSummary> => api.get<AnalyticsSummary>('/api/analytics/advertiser'),
  });

  const campaigns = useCampaigns(undefined, 10);
  const recentCampaigns = campaigns.data?.pages[0]?.items.slice(0, 3) ?? [];

  /* Membership badge. Renders nothing for a free account. */
  const premium = usePremiumMe();

  const notifs = useQuery({
    queryKey: [...qk.notifications, { page: 1, limit: 5 }],
    queryFn: async (): Promise<Paginated<NotificationRow>> =>
      api.get<Paginated<NotificationRow>>('/api/notifications', { page: 1, limit: 5 }),
  });

  const markRead = useMutation({
    mutationFn: (ids: string[]): Promise<unknown> => api.post('/api/notifications/read', { ids }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.notifications });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  /* Unread count for the header bell — polled every 60s. A 404 simply means
     no badge; the link still works. */
  const unread = useQuery({
    queryKey: qk.unreadCount,
    queryFn: (): Promise<UnreadCount> => api.get<UnreadCount>('/api/notifications/unread-count'),
    refetchInterval: 60_000,
  });

  const firstName = user?.firstName || user?.username || 'there';
  const d = dash.data;

  return (
    <div className="space-y-4">
      {/* Greeting */}
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold truncate">Hi, {firstName} 👋</h1>
            <PremiumBadge me={premium.data} withExpiry />
          </div>
          <p className="text-sm text-mute">Here's what's happening with your ads.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/notifications"
            className="relative w-10 h-10 rounded-full bg-surface border border-line flex items-center justify-center text-mute active:opacity-80"
            aria-label="Notifications"
          >
            <Icon name="bell" size={20} />
            {unread.data && unread.data.count > 0 && (
              <span className="num absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center">
                {unread.data.count > 99 ? '99+' : unread.data.count}
              </span>
            )}
          </Link>
          <Link
            to="/settings"
            className="w-10 h-10 rounded-full bg-surface border border-line flex items-center justify-center text-mute"
            aria-label="Settings"
          >
            <Icon name="settings" size={20} />
          </Link>
        </div>
      </div>

      {/* Balance */}
      {d ? (
        <BalanceCard wallet={d.balance} />
      ) : dash.isError ? (
        null
      ) : (
        <Skeleton className="h-28 w-full rounded-2xl" />
      )}

      {/* Stats */}
      {dash.isError ? (
        <ErrorState message={errMsg(dash.error)} onRetry={() => void dash.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            label="My channels"
            value={d ? String(d.channels) : '—'}
            icon={<Icon name="channel" size={16} />}
          />
          <StatCard
            label="Active campaigns"
            value={d ? String(d.activeCampaigns) : '—'}
            icon={<Icon name="megaphone" size={16} />}
          />
          <StatCard
            label="Total earned"
            value={d ? formatMoney(d.totalEarnedCents, d.balance.currency) : '—'}
            icon={<Icon name="coin" size={16} />}
          />
          <StatCard
            label="Total spent"
            value={d ? formatMoney(d.totalSpentCents, d.balance.currency) : '—'}
            icon={<Icon name="wallet" size={16} />}
          />
          <StatCard
            label="Pending earnings"
            value={d ? formatMoney(d.pendingEarningsCents, d.balance.currency) : '—'}
            sub="24h hold before payout"
            icon={<Icon name="clock" size={16} />}
            className="col-span-2"
          />
        </div>
      )}

      {/* Quick actions */}
      <div>
        <CardTitle>Quick actions</CardTitle>
        <div className="grid grid-cols-4 gap-2.5">
          <QuickAction to="/advertise/new" icon="megaphone" label="New campaign" />
          <QuickAction to="/channels/new" icon="channel" label="Add channel" />
          <QuickAction to="/wallet/deposit" icon="arrowDown" label="Deposit" />
          <QuickAction to="/wallet/withdraw" icon="arrowUp" label="Withdraw" />
        </div>
      </div>

      {/* Recent campaigns */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-mute uppercase tracking-wide">Recent campaigns</h3>
          <Link to="/campaigns" className="text-sm text-link font-medium">
            View all
          </Link>
        </div>
        {campaigns.isLoading ? (
          <Skeleton className="h-24 w-full rounded-2xl" />
        ) : recentCampaigns.length === 0 ? (
          <Card>
            <p className="text-sm text-mute text-center py-3">
              No campaigns yet.{' '}
              <Link to="/advertise/new" className="text-link font-semibold">
                Create your first one →
              </Link>
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {recentCampaigns.map((c) => (
              <CampaignCard key={c.id} campaign={c} />
            ))}
          </div>
        )}
      </div>

      {/* Ad performance */}
      {adv.data && (
        <Card>
          <CardTitle>Ad performance (all time)</CardTitle>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-lg font-bold">{adv.data.totalViews.toLocaleString()}</p>
              <p className="text-xs text-mute">Views</p>
            </div>
            <div>
              <p className="text-lg font-bold">{adv.data.totalClicks.toLocaleString()}</p>
              <p className="text-xs text-mute">Clicks</p>
            </div>
            <div>
              <p className="text-lg font-bold text-link">{adv.data.ctr.toFixed(2)}%</p>
              <p className="text-xs text-mute">CTR</p>
            </div>
          </div>
        </Card>
      )}

      {/* Notifications */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-mute uppercase tracking-wide">Notifications</h3>
          {!notifs.isLoading && notifs.data && notifs.data.items.some((n) => !n.isRead) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                markRead.mutate(notifs.data!.items.filter((n) => !n.isRead).map((n) => n.id))
              }
            >
              Mark all read
            </Button>
          )}
        </div>
        {notifs.isLoading ? (
          <Skeleton className="h-20 w-full rounded-2xl" />
        ) : notifs.isError ? (
          <ErrorState message={errMsg(notifs.error)} onRetry={() => void notifs.refetch()} />
        ) : notifs.data && notifs.data.items.length > 0 ? (
          <Card padded={false} className="divide-y divide-line">
            {notifs.data.items.map((n) => (
              <div key={n.id} className="flex items-start gap-3 p-3.5">
                <span
                  className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${n.isRead ? 'bg-line' : 'bg-accent'}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-snug">{n.title}</p>
                  {n.body && <p className="text-xs text-mute mt-0.5 line-clamp-2">{n.body}</p>}
                  <p className="text-[11px] text-mute mt-1">{formatDateTime(n.createdAt)}</p>
                </div>
              </div>
            ))}
          </Card>
        ) : (
          <Card>
            <p className="text-sm text-mute text-center py-3">You're all caught up 🎉</p>
          </Card>
        )}
      </div>

      <p className="text-center text-xs text-mute pb-2">BotFlow Ads · sponsored posts across Telegram</p>
    </div>
  );
}

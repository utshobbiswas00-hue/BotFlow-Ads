/**
 * Overview — the numbers an operator checks first, plus the queue health that
 * says whether the platform is actually delivering.
 *
 * Three endpoints the backend already exposed and that had no screen at all:
 * `GET /admin/dashboard`, `GET /admin/dashboard/queues`, `GET
 * /admin/analytics/revenue`. Each "needs attention" tile links to the filtered
 * list it summarises, so a number that looks wrong is one click from its rows.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { groupNumber } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { Money } from '../../components/ui/Money';
import { Icon } from '../../components/ui/icons';
import { LineChart } from '../../components/charts/LineChart';
import { getDashboard, getQueueStats, getRevenue } from '../lib/api';
import { AdminPageHeader, KpiGrid, KpiTile, Section } from '../components/Kpi';
import { QueryState } from '../components/StateBlock';

export function AdminOverviewPage() {
  const navigate = useNavigate();
  const dashboard = useQuery({ queryKey: qk.adminDashboard, queryFn: getDashboard });
  const queues = useQuery({ queryKey: qk.adminQueues, queryFn: getQueueStats });
  const revenue = useQuery({
    queryKey: [...qk.adminRevenue, 30],
    queryFn: () => getRevenue(30),
  });

  const d = dashboard.data;

  return (
    <>
      <AdminPageHeader
        title="Overview"
        description="Platform health as of now. Revenue counts the platform fee booked on posts that actually published, so it is money earned, not money held in escrow."
      />

      <QueryState
        isPending={dashboard.isPending}
        isError={dashboard.isError}
        error={dashboard.error}
        onRetry={() => void dashboard.refetch()}
        skeletonRows={4}
      >
        {d ? (
          <div className="space-y-8">
            <Section title="Revenue" description="Platform fee booked on published posts.">
              <KpiGrid>
                <KpiTile
                  label="Today"
                  value={<Money cents={d.todayRevenueCents} />}
                  icon="dollar"
                  tone={d.todayRevenueCents > 0 ? 'good' : 'neutral'}
                />
                <KpiTile label="All time" value={<Money cents={d.totalRevenueCents} />} icon="chart" />
                <KpiTile
                  label="Active campaigns"
                  value={groupNumber(d.activeCampaigns)}
                  sub={
                    d.pendingCampaigns > 0
                      ? `${d.pendingCampaigns} awaiting review`
                      : 'Nothing queued'
                  }
                  icon="megaphone"
                  tone={d.pendingCampaigns > 0 ? 'warn' : 'neutral'}
                  onClick={() => navigate('/admin/campaigns?status=PENDING_REVIEW')}
                />
                <KpiTile
                  label="Approved channels"
                  value={groupNumber(d.approvedChannels)}
                  icon="channel"
                  onClick={() => navigate('/admin/channels?status=APPROVED')}
                />
              </KpiGrid>
            </Section>

            <Section title="Needs attention" description="Each tile opens the filtered list it counts.">
              <KpiGrid>
                <KpiTile
                  label="Pending deposits"
                  value={groupNumber(d.pendingDeposits)}
                  icon="arrowDown"
                  tone={d.pendingDeposits > 0 ? 'warn' : 'neutral'}
                  onClick={() => navigate('/admin/finance/deposits?status=PENDING')}
                />
                <KpiTile
                  label="Pending withdrawals"
                  value={groupNumber(d.pendingWithdrawals)}
                  icon="arrowUp"
                  tone={d.pendingWithdrawals > 0 ? 'warn' : 'neutral'}
                  onClick={() => navigate('/admin/finance/withdrawals?status=PENDING')}
                />
                <KpiTile
                  label="Failed deliveries"
                  value={groupNumber(d.failedDeliveries)}
                  icon="alert"
                  tone={d.failedDeliveries > 0 ? 'bad' : 'good'}
                  onClick={() => navigate('/admin/delivery?status=FAILED')}
                />
                <KpiTile
                  label="Unresolved fraud events"
                  value={groupNumber(d.fraudAlerts)}
                  icon="shield"
                  tone={d.fraudAlerts > 0 ? 'bad' : 'good'}
                  onClick={() => navigate('/admin/moderation')}
                />
              </KpiGrid>
            </Section>

            <Section
              title="Users"
              description="Registered accounts and which side of the market they joined."
            >
              <KpiGrid>
                <KpiTile label="Total users" value={groupNumber(d.totalUsers)} icon="user" />
                <KpiTile
                  label="Active users"
                  value={groupNumber(d.activeUsers)}
                  sub={`${d.totalUsers > 0 ? Math.round((d.activeUsers / d.totalUsers) * 100) : 0}% of all accounts`}
                  icon="check"
                />
                <KpiTile label="Advertisers" value={groupNumber(d.advertisers)} icon="megaphone" />
                <KpiTile label="Publishers" value={groupNumber(d.publishers)} icon="channel" />
              </KpiGrid>
            </Section>
          </div>
        ) : null}
      </QueryState>

      <div className="grid gap-6 lg:grid-cols-2 mt-8">
        <Section title="Delivery queue" description="Where every scheduled ad post currently sits.">
          <QueryState
            isPending={queues.isPending}
            isError={queues.isError}
            error={queues.error}
            onRetry={() => void queues.refetch()}
            skeletonRows={3}
          >
            {queues.data ? (
              <div className="bg-surface border border-line rounded-2xl divide-y divide-line/60">
                <QueueRow label="Published" value={queues.data.published} tone="good" />
                <QueueRow label="In flight" value={queues.data.pending} tone="warn" />
                <QueueRow
                  label="Awaiting publisher approval"
                  value={queues.data.awaitingApproval}
                  tone="warn"
                />
                <QueueRow label="Failed" value={queues.data.failed} tone="bad" />
                <QueueRow label="Cancelled" value={queues.data.cancelled} tone="neutral" />
                <QueueRow label="Total jobs" value={queues.data.total} tone="neutral" strong />
              </div>
            ) : null}
          </QueryState>
          <Link to="/admin/delivery" className="inline-flex items-center gap-1.5 text-xs text-link hover:underline mt-1">
            Open the delivery queue
            <Icon name="chevronRight" size={13} />
          </Link>
        </Section>

        <Section title="Revenue, last 30 days" description="Platform fee per UTC day.">
          <div className="bg-surface border border-line rounded-2xl p-3">
            <QueryState
              isPending={revenue.isPending}
              isError={revenue.isError}
              error={revenue.error}
              onRetry={() => void revenue.refetch()}
              skeletonRows={2}
            >
              <LineChart
                kind="money"
                height={220}
                data={(revenue.data?.byDay ?? []).map((p) => ({
                  label: p.date.slice(5),
                  value: p.revenueCents,
                }))}
              />
            </QueryState>
          </div>
        </Section>
      </div>
    </>
  );
}

function QueueRow({
  label,
  value,
  tone,
  strong = false,
}: {
  label: string;
  value: number;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  strong?: boolean;
}) {
  const toneCls =
    value === 0
      ? 'text-mute'
      : tone === 'good'
        ? 'text-ok'
        : tone === 'warn'
          ? 'text-warn'
          : tone === 'bad'
            ? 'text-danger'
            : 'text-ink';

  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className={strong ? 'text-sm font-semibold' : 'text-sm'}>{label}</span>
      <span className={`num text-sm ${strong ? 'font-bold' : 'font-medium'} ${toneCls}`}>
        {groupNumber(value)}
      </span>
    </div>
  );
}

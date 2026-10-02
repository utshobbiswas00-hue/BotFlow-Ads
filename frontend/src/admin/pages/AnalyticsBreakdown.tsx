/**
 * Analytics breakdown (spec §7, §39–42).
 *
 * The companion to the revenue screen: this one gathers every aggregate the
 * backend computes with `groupBy`/`aggregate` — campaign status, delivery
 * outcomes, channel mix and the product funnel — behind a single day-window
 * selector.
 *
 * Two deliberate choices:
 *  - every panel is wrapped in its OWN `QueryState`. These are five independent
 *    endpoints; a failing delivery aggregate must not blank out the campaign
 *    panel next to it.
 *  - the funnel is rendered as an ORDERED STEP LIST, not a bar chart. It is a
 *    sequence (channels approved → campaigns created → approved → scheduled →
 *    published), so the number that matters is the drop-off between consecutive
 *    steps. When a step is LARGER than the one before it the list says so out
 *    loud rather than clamping it to 0% — that means the metric is not a strict
 *    funnel and hiding it would be a lie.
 */
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { qk } from '../../lib/queryClient';
import { groupNumber } from '../../lib/format';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Money } from '../../components/ui/Money';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { LineChart } from '../../components/charts/LineChart';
import {
  getCampaignAnalytics,
  getChannelAnalytics,
  getDeliveryAnalytics,
  getFunnel,
  getUserGrowth,
} from '../lib/api';
import { AdminPageHeader, KpiGrid, KpiTile, Section } from '../components/Kpi';
import { DataTable, type Column } from '../components/DataTable';
import { QueryState } from '../components/StateBlock';
import type { CampaignStatusAggregate, UserGrowthPoint } from '../lib/types';

const RANGES = [7, 30, 90, 180, 365] as const;

/** Spent / budget proportion. The bar carries the share; the % text carries the number. */
function BudgetBar({ spentCents, totalCents }: { spentCents: number; totalCents: number }) {
  const pct = totalCents > 0 ? (spentCents / totalCents) * 100 : 0;
  const width = Math.max(0, Math.min(100, pct));
  const over = spentCents > totalCents;
  return (
    <div className="min-w-40">
      <div className="h-2 rounded-full bg-app border border-line overflow-hidden">
        <div
          className={over ? 'h-full bg-danger' : 'h-full bg-accent'}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="text-[11px] text-mute mt-1 num">
        {pct.toFixed(0)}% spent{over ? ' · over budget' : ''}
      </div>
    </div>
  );
}

interface FunnelStep {
  key: string;
  label: string;
  value: number;
}

/**
 * Ordered funnel steps with the drop-off between consecutive ones. A step that
 * exceeds its predecessor is flagged explicitly — it is the honest signal that
 * these lifetime counts are not a strict funnel.
 */
function FunnelSteps({ steps }: { steps: FunnelStep[] }) {
  return (
    <ol className="space-y-2">
      {steps.map((step, i) => {
        const prev = i > 0 ? steps[i - 1] : null;
        const increased = prev !== null && step.value > prev.value;
        const dropPct = prev && prev.value > 0 ? ((prev.value - step.value) / prev.value) * 100 : null;

        let note: ReactNode;
        if (i === 0) {
          note = <span className="text-xs text-mute">Starting point of the loop.</span>;
        } else if (!prev || prev.value === 0) {
          note = <span className="text-xs text-mute">No comparable previous step (it was 0).</span>;
        } else if (increased) {
          note = (
            <span className="text-xs text-warn">
              {groupNumber(step.value - prev.value)} more than “{prev.label}” — this step is larger
              than the one before it, so the counts are not a strict funnel.
            </span>
          );
        } else {
          note = (
            <span className="text-xs text-mute">
              {dropPct !== null ? `${dropPct.toFixed(1)}% drop-off` : '—'} from “{prev.label}”.
            </span>
          );
        }

        return (
          <li
            key={step.key}
            className="bg-surface border border-line rounded-2xl p-3 flex items-start gap-3"
          >
            <span className="w-6 h-6 rounded-full bg-app border border-line flex items-center justify-center text-xs font-semibold shrink-0">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{step.label}</span>
                <span className="num text-lg font-bold">{groupNumber(step.value)}</span>
              </div>
              <div className="mt-1">{note}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function AnalyticsBreakdownPage() {
  const [days, setDays] = useState(30);

  const campaignsQuery = useQuery({
    queryKey: qk.adminAnalyticsCampaigns,
    queryFn: getCampaignAnalytics,
  });
  const deliveryQuery = useQuery({
    queryKey: [...qk.adminAnalyticsDelivery, days],
    queryFn: () => getDeliveryAnalytics(days),
  });
  const usersQuery = useQuery({
    queryKey: [...qk.adminAnalyticsUsers, days],
    queryFn: () => getUserGrowth(days),
  });
  const channelsQuery = useQuery({
    queryKey: qk.adminAnalyticsChannels,
    queryFn: getChannelAnalytics,
  });
  const funnelQuery = useQuery({
    queryKey: qk.adminAnalyticsFunnel,
    queryFn: getFunnel,
  });

  const refreshAll = (): void => {
    void campaignsQuery.refetch();
    void deliveryQuery.refetch();
    void usersQuery.refetch();
    void channelsQuery.refetch();
    void funnelQuery.refetch();
  };

  const campaigns = campaignsQuery.data;
  const delivery = deliveryQuery.data;
  const growth = usersQuery.data;
  const channels = channelsQuery.data;
  const funnel = funnelQuery.data;

  const campaignColumns: Column<CampaignStatusAggregate>[] = [
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'count',
      header: 'Campaigns',
      align: 'right',
      nowrap: true,
      render: (r) => <span className="num">{groupNumber(r.count)}</span>,
    },
    {
      key: 'budget',
      header: 'Budget',
      align: 'right',
      nowrap: true,
      render: (r) => <Money cents={r.budgetTotalCents} />,
    },
    {
      key: 'spent',
      header: 'Spent',
      align: 'right',
      nowrap: true,
      render: (r) => <Money cents={r.budgetSpentCents} />,
    },
    {
      key: 'bar',
      header: 'Utilisation',
      hideBelow: 'md',
      render: (r) => <BudgetBar spentCents={r.budgetSpentCents} totalCents={r.budgetTotalCents} />,
    },
  ];

  const deliveryColumns: Column<{ status: string; count: number }>[] = [
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'count',
      header: 'Jobs',
      align: 'right',
      nowrap: true,
      render: (r) => <span className="num">{groupNumber(r.count)}</span>,
    },
    {
      key: 'share',
      header: 'Share',
      align: 'right',
      nowrap: true,
      render: (r) => (
        <span className="num text-mute">
          {delivery && delivery.total > 0 ? `${((r.count / delivery.total) * 100).toFixed(1)}%` : '—'}
        </span>
      ),
    },
  ];

  const channelStatusColumns: Column<{ status: string; count: number }>[] = [
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'count',
      header: 'Channels',
      align: 'right',
      nowrap: true,
      render: (r) => <span className="num">{groupNumber(r.count)}</span>,
    },
  ];

  const channelCategoryColumns: Column<{ category: string; count: number }>[] = [
    { key: 'category', header: 'Category', render: (r) => <span className="text-sm">{r.category}</span> },
    {
      key: 'count',
      header: 'Channels',
      align: 'right',
      nowrap: true,
      render: (r) => <span className="num">{groupNumber(r.count)}</span>,
    },
  ];

  const growthColumns: Column<UserGrowthPoint>[] = [
    { key: 'date', header: 'UTC day', render: (r) => <span className="num text-xs text-mute">{r.date}</span> },
    {
      key: 'newUsers',
      header: 'New users',
      align: 'right',
      nowrap: true,
      render: (r) => <span className="num">{groupNumber(r.newUsers)}</span>,
    },
    {
      key: 'publishers',
      header: 'Publishers',
      align: 'right',
      nowrap: true,
      render: (r) => <span className="num">{groupNumber(r.publishers)}</span>,
    },
    {
      key: 'advertisers',
      header: 'Advertisers',
      align: 'right',
      nowrap: true,
      render: (r) => <span className="num">{groupNumber(r.advertisers)}</span>,
    },
  ];

  const funnelSteps: FunnelStep[] = funnel
    ? [
        { key: 'channelsApproved', label: 'Channels approved', value: funnel.channelsApproved },
        { key: 'campaignsCreated', label: 'Campaigns created', value: funnel.campaignsCreated },
        { key: 'campaignsApproved', label: 'Campaigns approved', value: funnel.campaignsApproved },
        { key: 'postsScheduled', label: 'Posts scheduled', value: funnel.postsScheduled },
        { key: 'postsPublished', label: 'Posts published', value: funnel.postsPublished },
      ]
    : [];

  const rangePicker = (
    <div className="flex flex-wrap items-center gap-1.5">
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => setDays(r)}
          className={
            r === days
              ? 'h-8 px-3 rounded-lg bg-ink text-app text-xs font-medium'
              : 'h-8 px-3 rounded-lg border border-line bg-surface text-xs font-medium'
          }
        >
          {r}d
        </button>
      ))}
      <Button
        variant="secondary"
        size="sm"
        icon={<Icon name="refresh" size={15} />}
        onClick={refreshAll}
      >
        Refresh
      </Button>
    </div>
  );

  return (
    <>
      <AdminPageHeader
        title="Analytics breakdown"
        description="Campaign, delivery, channel, growth and funnel aggregates. Each panel loads and fails independently — a broken aggregate never blanks the rest of the page."
        actions={rangePicker}
      />

      <div className="space-y-6">
        {/* ---------- Campaigns by status ---------- */}
        <Section
          title="Campaigns by status"
          description="Counts and budget totals per lifecycle status, grouped server-side."
        >
          <QueryState
            isPending={campaignsQuery.isPending}
            isError={campaignsQuery.isError}
            error={campaignsQuery.error}
            isEmpty={!!campaigns && campaigns.byStatus.length === 0}
            emptyTitle="No campaigns yet"
            emptyMessage="No campaign exists, so there is nothing to group by status."
            onRetry={() => void campaignsQuery.refetch()}
            skeletonRows={3}
          >
            {campaigns ? (
              <div className="space-y-3">
                <KpiGrid className="lg:grid-cols-4">
                  <KpiTile label="Campaigns" value={groupNumber(campaigns.totals.count)} icon="megaphone" />
                  <KpiTile
                    label="Total budget"
                    value={<Money cents={campaigns.totals.budgetTotalCents} />}
                    icon="coin"
                  />
                  <KpiTile
                    label="Spent"
                    value={<Money cents={campaigns.totals.budgetSpentCents} />}
                    icon="dollar"
                  />
                  <KpiTile
                    label="Remaining budget"
                    value={<Money cents={campaigns.totals.budgetTotalCents - campaigns.totals.budgetSpentCents} />}
                    icon="wallet"
                  />
                </KpiGrid>
                <DataTable
                  rows={campaigns.byStatus}
                  columns={campaignColumns}
                  rowKey={(r) => r.status}
                  emptyTitle="No campaigns"
                  emptyMessage="No campaign exists yet."
                />
              </div>
            ) : null}
          </QueryState>
        </Section>

        {/* ---------- Delivery by status ---------- */}
        <Section
          title={`Delivery by status (last ${days}d)`}
          description="Delivery-job outcomes in the window, plus the mean attempt count as a retry-pressure signal."
        >
          <QueryState
            isPending={deliveryQuery.isPending}
            isError={deliveryQuery.isError}
            error={deliveryQuery.error}
            isEmpty={!!delivery && delivery.byStatus.length === 0}
            emptyTitle="No delivery jobs"
            emptyMessage={`No delivery job was created in the last ${days} days.`}
            onRetry={() => void deliveryQuery.refetch()}
            skeletonRows={3}
          >
            {delivery ? (
              <div className="space-y-3">
                <KpiGrid className="lg:grid-cols-2">
                  <KpiTile
                    label="Mean attempts"
                    value={delivery.avgAttempts.toFixed(2)}
                    sub="Across all jobs in the window — higher means more retrying."
                    icon="refresh"
                  />
                  <KpiTile label="Jobs in window" value={groupNumber(delivery.total)} icon="send" />
                </KpiGrid>
                <DataTable
                  rows={delivery.byStatus}
                  columns={deliveryColumns}
                  rowKey={(r) => r.status}
                  emptyTitle="No delivery jobs"
                  emptyMessage={`No delivery job was created in the last ${days} days.`}
                />
              </div>
            ) : null}
          </QueryState>
        </Section>

        {/* ---------- Channels ---------- */}
        <Section
          title="Channels"
          description="Publisher channels by status and by category, with the platform-wide totals."
        >
          <QueryState
            isPending={channelsQuery.isPending}
            isError={channelsQuery.isError}
            error={channelsQuery.error}
            isEmpty={!!channels && channels.byStatus.length === 0 && channels.byCategory.length === 0}
            emptyTitle="No channels yet"
            emptyMessage="No publisher channel has been registered."
            onRetry={() => void channelsQuery.refetch()}
            skeletonRows={4}
          >
            {channels ? (
              <div className="space-y-4">
                <KpiGrid className="lg:grid-cols-3">
                  <KpiTile
                    label="Approved channels"
                    value={groupNumber(channels.totals.approved)}
                    tone="good"
                    icon="check"
                  />
                  <KpiTile
                    label="Needs attention"
                    value={groupNumber(channels.totals.attentionRequired)}
                    tone={channels.totals.attentionRequired > 0 ? 'warn' : 'neutral'}
                    icon="alert"
                  />
                  <KpiTile
                    label="Total subscribers"
                    value={groupNumber(channels.totals.totalSubscribers)}
                    icon="user"
                  />
                </KpiGrid>
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-mute uppercase tracking-wide">By status</h3>
                    <DataTable
                      rows={channels.byStatus}
                      columns={channelStatusColumns}
                      rowKey={(r) => r.status}
                      emptyTitle="No channels"
                      emptyMessage="No channel has a status to group by."
                    />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-mute uppercase tracking-wide">By category</h3>
                    <DataTable
                      rows={channels.byCategory}
                      columns={channelCategoryColumns}
                      rowKey={(r) => r.category}
                      emptyTitle="No categories"
                      emptyMessage="No channel has a category to group by."
                    />
                  </div>
                </div>
              </div>
            ) : null}
          </QueryState>
        </Section>

        {/* ---------- User growth ---------- */}
        <Section
          title={`User growth (last ${days}d)`}
          description="New users per UTC day. Publishers and advertisers are carried by the table below the chart."
        >
          <QueryState
            isPending={usersQuery.isPending}
            isError={usersQuery.isError}
            error={usersQuery.error}
            isEmpty={!!growth && growth.byDay.length === 0}
            emptyTitle="No growth data"
            emptyMessage={`No signups were recorded in the last ${days} days.`}
            onRetry={() => void usersQuery.refetch()}
            skeletonRows={4}
          >
            {growth ? (
              <div className="space-y-3">
                <div className="bg-surface border border-line rounded-2xl p-3">
                  <LineChart
                    kind="number"
                    height={240}
                    data={growth.byDay.map((d) => ({ label: d.date.slice(5), value: d.newUsers }))}
                  />
                </div>
                <DataTable
                  rows={[...growth.byDay].reverse()}
                  columns={growthColumns}
                  rowKey={(r) => r.date}
                  emptyTitle="No growth data"
                  emptyMessage={`No signups were recorded in the last ${days} days.`}
                />
              </div>
            ) : null}
          </QueryState>
        </Section>

        {/* ---------- Funnel ---------- */}
        <Section
          title="Product funnel"
          description="Lifetime counts in the order the loop runs. Drop-off is measured between consecutive steps; a step larger than its predecessor is labelled, not hidden."
        >
          <QueryState
            isPending={funnelQuery.isPending}
            isError={funnelQuery.isError}
            error={funnelQuery.error}
            onRetry={() => void funnelQuery.refetch()}
            skeletonRows={5}
          >
            {funnel ? (
              <div className="space-y-3">
                <FunnelSteps steps={funnelSteps} />
                <KpiGrid className="lg:grid-cols-2">
                  <KpiTile
                    label="Posts failed"
                    value={groupNumber(funnel.postsFailed)}
                    tone={funnel.postsFailed > 0 ? 'bad' : 'neutral'}
                    sub="Not a funnel step — failed posts never reached published."
                    icon="x"
                  />
                  <KpiTile
                    label="Earnings rows"
                    value={groupNumber(funnel.earningsRows)}
                    sub="Not a funnel step — a row per published post that earned."
                    icon="coin"
                  />
                </KpiGrid>
              </div>
            ) : null}
          </QueryState>
        </Section>
      </div>
    </>
  );
}

/**
 * Per-channel analytics (spec §41).
 *
 * The companion to the channels list: one publisher channel's delivery record,
 * earnings split and measured reach, read from
 * `GET /admin/analytics/channels/:id`.
 *
 * The contract shape (`ChannelAnalyticsDetail`) drives two rules this screen
 * does not break:
 *  - `delivery.successRatePct` and `reach.ctrPct` are `null` when the
 *    measurement does not exist (nothing ran / no impressions). Null is NOT
 *    zero: rendering it as "0%" would claim a measurement that was never taken,
 *    so both are shown as "Not measurable" in words.
 *  - `channel.avgViews` (the channel's own reported average per post) and
 *    `reach.impressions` (impressions recorded by delivery) are different
 *    measurements. Both are rendered, each labelled as what it is.
 */
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { groupNumber } from '../../lib/format';
import { isNotFoundError } from '../../lib/errors';
import { qk } from '../../lib/queryClient';
import { Icon } from '../../components/ui/icons';
import { Money } from '../../components/ui/Money';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { getChannelAnalyticsDetail } from '../lib/api';
import { AdminPageHeader, KpiGrid, KpiTile, Section } from '../components/Kpi';
import { DataTable, type Column } from '../components/DataTable';
import { ErrorBlock, QueryState } from '../components/StateBlock';
import type { ChannelAnalyticsDetail } from '../lib/types';

/** A percentage the API left null is unmeasured, not zero. Say so in words. */
function Percent({ value }: { value: number | null }) {
  if (value === null) return <span className="text-mute">Not measurable</span>;
  return <span className="num">{value.toFixed(2)}%</span>;
}

interface MetricRow {
  key: string;
  label: string;
  value: ReactNode;
  note?: ReactNode;
}

const metricColumns: Column<MetricRow>[] = [
  { key: 'label', header: 'Metric', render: (r) => <span className="text-sm">{r.label}</span> },
  { key: 'value', header: 'Value', align: 'right', nowrap: true, render: (r) => r.value },
  {
    key: 'note',
    header: 'Note',
    hideBelow: 'md',
    render: (r) => <span className="text-xs text-mute">{r.note ?? ''}</span>,
  },
];

export function ChannelAnalyticsPage() {
  const { channelId = '' } = useParams<{ channelId: string }>();

  const query = useQuery({
    queryKey: qk.adminChannelAnalytics(channelId),
    queryFn: () => getChannelAnalyticsDetail(channelId),
    enabled: Boolean(channelId),
  });

  const back = (
    <Link
      to="/admin/channels"
      className="inline-flex items-center gap-1.5 text-xs text-link hover:underline mb-3"
    >
      <Icon name="back" size={14} />
      All channels
    </Link>
  );

  if (!channelId) {
    return (
      <>
        {back}
        <ErrorBlock error={new Error('No channel id in the URL')} />
      </>
    );
  }

  // A 404 means this id does not exist — a specific, expected state, not the
  // generic "could not load" block.
  if (isNotFoundError(query.error)) {
    return (
      <>
        {back}
        <NotFoundBlock
          message={`No channel exists with id “${channelId}”. It may have been removed, or the link is out of date.`}
        />
      </>
    );
  }

  const d = query.data;

  return (
    <>
      {back}

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        skeletonRows={5}
      >
        {d ? (
          <>
            <AdminPageHeader
              title={d.channel.title}
              description={`${
                d.channel.username ? `@${d.channel.username.replace(/^@/, '')}` : 'private'
              } · owned by ${d.channel.ownerName} · ${groupNumber(d.channel.subscriberCount)} subscribers`}
              actions={<StatusBadge status={d.channel.status} />}
            />

            <div className="space-y-6">
              <KpiGrid>
                <KpiTile
                  label="Subscribers"
                  value={groupNumber(d.channel.subscriberCount)}
                  icon="user"
                />
                <KpiTile
                  label="Avg views / post"
                  value={groupNumber(d.channel.avgViews)}
                  sub="The channel's own reported average"
                  icon="eye"
                />
                <KpiTile
                  label="Published deliveries"
                  value={groupNumber(d.delivery.published)}
                  sub={`${groupNumber(d.delivery.failed)} failed · ${groupNumber(d.delivery.scheduled)} scheduled`}
                  icon="send"
                />
                <KpiTile
                  label="Delivery success rate"
                  value={<Percent value={d.delivery.successRatePct} />}
                  sub="published ÷ (published + failed)"
                  icon="chart"
                />
              </KpiGrid>

              <Section
                title="Performance"
                description="Published-post counts and the gross / net / platform-fee split."
              >
                <DataTable
                  rows={performanceRows(d)}
                  columns={metricColumns}
                  rowKey={(r) => r.key}
                  emptyTitle="No performance data"
                />
              </Section>

              <Section
                title="Delivery"
                description="Scheduled / published / failed counts, plus the run success rate."
              >
                <DataTable
                  rows={deliveryRows(d)}
                  columns={metricColumns}
                  rowKey={(r) => r.key}
                  emptyTitle="No delivery data"
                />
              </Section>

              <Section
                title="Reach"
                description="Two different view measurements are shown side by side and labelled: the channel's own average, and the impressions delivery actually recorded."
              >
                <DataTable
                  rows={reachRows(d)}
                  columns={metricColumns}
                  rowKey={(r) => r.key}
                  emptyTitle="No reach data"
                />
              </Section>
            </div>
          </>
        ) : null}
      </QueryState>
    </>
  );
}

function performanceRows(d: ChannelAnalyticsDetail): MetricRow[] {
  return [
    {
      key: 'posts',
      label: 'Posts',
      value: <span className="num">{groupNumber(d.performance.posts)}</span>,
    },
    {
      key: 'gross',
      label: 'Gross',
      value: <Money cents={d.performance.grossCents} />,
    },
    {
      key: 'net',
      label: 'Net to publisher',
      value: <Money cents={d.performance.netCents} />,
    },
    {
      key: 'fee',
      label: 'Platform fee',
      value: <Money cents={d.performance.platformFeeCents} />,
    },
  ];
}

function deliveryRows(d: ChannelAnalyticsDetail): MetricRow[] {
  return [
    { key: 'scheduled', label: 'Scheduled', value: <span className="num">{groupNumber(d.delivery.scheduled)}</span> },
    { key: 'published', label: 'Published', value: <span className="num">{groupNumber(d.delivery.published)}</span> },
    { key: 'failed', label: 'Failed', value: <span className="num">{groupNumber(d.delivery.failed)}</span> },
    {
      key: 'successRate',
      label: 'Success rate',
      value: <Percent value={d.delivery.successRatePct} />,
      note:
        d.delivery.successRatePct === null
          ? 'Nothing has run yet, so there is no rate to report.'
          : 'published ÷ (published + failed).',
    },
  ];
}

function reachRows(d: ChannelAnalyticsDetail): MetricRow[] {
  return [
    {
      key: 'avgViews',
      label: 'Channel average views',
      value: <span className="num">{groupNumber(d.channel.avgViews)}</span>,
      note: 'The channel’s own reported average per post.',
    },
    {
      key: 'impressions',
      label: 'Measured impressions',
      value: <span className="num">{groupNumber(d.reach.impressions)}</span>,
      note: 'Impressions recorded by delivery — a different measurement from the channel average above.',
    },
    {
      key: 'clicks',
      label: 'Clicks',
      value: <span className="num">{groupNumber(d.reach.clicks)}</span>,
      note: 'Tracked link clicks.',
    },
    {
      key: 'ctr',
      label: 'CTR',
      value: <Percent value={d.reach.ctrPct} />,
      note:
        d.reach.ctrPct === null
          ? 'No impressions were measured, so a click-through rate cannot be computed.'
          : 'clicks ÷ measured impressions.',
    },
  ];
}

function NotFoundBlock({ message }: { message: string }) {
  return (
    <div className="py-12">
      <div className="flex flex-col items-center text-center">
        <span className="w-12 h-12 rounded-2xl bg-app border border-line text-mute flex items-center justify-center mb-3">
          <Icon name="alert" size={22} />
        </span>
        <p className="font-semibold text-sm">Channel not found</p>
        <p className="text-xs text-mute max-w-md mt-1">{message}</p>
        <Link
          to="/admin/channels"
          className="mt-4 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-ink text-app text-sm font-medium"
        >
          <Icon name="back" size={15} />
          Back to channels
        </Link>
      </div>
    </div>
  );
}

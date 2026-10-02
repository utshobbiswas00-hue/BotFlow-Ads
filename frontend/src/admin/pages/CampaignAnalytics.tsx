/**
 * Per-campaign analytics (spec §40).
 *
 * The companion to the campaigns list: one campaign's budget, delivery outcomes
 * and measured reach, read from `GET /admin/analytics/campaigns/:id`.
 *
 * The contract shape (`CampaignAnalyticsDetail`) drives two rules this screen
 * does not break:
 *  - `delivery.successRatePct` and `reach.ctrPct` are `null` when the
 *    measurement does not exist (nothing ran / no impressions). Null is NOT
 *    zero: rendering it as "0%" would claim a measurement that was never taken,
 *    so both are shown as "Not measurable" in words.
 *  - `reach.impressions` is CPM-measured views and is legitimately 0 for a
 *    fixed-price campaign. It is labelled as such and never conflated with the
 *    click count.
 */
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatDate, formatMoney, groupNumber } from '../../lib/format';
import { isNotFoundError } from '../../lib/errors';
import { qk } from '../../lib/queryClient';
import { Icon } from '../../components/ui/icons';
import { Money } from '../../components/ui/Money';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { getCampaignAnalyticsDetail } from '../lib/api';
import { AdminPageHeader, KpiGrid, KpiTile, Section } from '../components/Kpi';
import { DataTable, type Column } from '../components/DataTable';
import { ErrorBlock, QueryState } from '../components/StateBlock';
import type { CampaignAnalyticsDetail } from '../lib/types';

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

export function CampaignAnalyticsPage() {
  const { campaignId = '' } = useParams<{ campaignId: string }>();

  const query = useQuery({
    queryKey: qk.adminCampaignAnalytics(campaignId),
    queryFn: () => getCampaignAnalyticsDetail(campaignId),
    enabled: Boolean(campaignId),
  });

  const back = (
    <Link
      to="/admin/campaigns"
      className="inline-flex items-center gap-1.5 text-xs text-link hover:underline mb-3"
    >
      <Icon name="back" size={14} />
      All campaigns
    </Link>
  );

  if (!campaignId) {
    return (
      <>
        {back}
        <ErrorBlock error={new Error('No campaign id in the URL')} />
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
          message={`No campaign exists with id “${campaignId}”. It may have been deleted, or the link is out of date.`}
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
              title={d.campaign.name}
              description={`${d.campaign.advertiserName} · created ${formatDate(d.campaign.createdAt)} · runs ${formatDate(
                d.campaign.startAt,
              )} → ${formatDate(d.campaign.endAt)}`}
              actions={<StatusBadge status={d.campaign.status} />}
            />

            <div className="space-y-6">
              <KpiGrid>
                <KpiTile
                  label="Spent"
                  value={<Money cents={d.budget.spentCents} />}
                  sub={`of ${formatMoney(d.budget.totalCents)} budget`}
                  icon="megaphone"
                />
                <KpiTile
                  label="Remaining"
                  value={<Money cents={d.budget.remainingCents} />}
                  sub={`${formatMoney(d.budget.reservedCents)} reserved`}
                  icon="wallet"
                />
                <KpiTile
                  label="Delivery success rate"
                  value={<Percent value={d.delivery.successRatePct} />}
                  sub="published ÷ (published + failed)"
                  icon="send"
                />
                <KpiTile
                  label="CTR"
                  value={<Percent value={d.reach.ctrPct} />}
                  sub="clicks ÷ measured impressions"
                  icon="target"
                />
              </KpiGrid>

              <Section
                title="Budget"
                description="Every figure straight from the campaign's budget breakdown."
              >
                <div className="bg-surface border border-line rounded-2xl divide-y divide-line/60 text-sm">
                  <Row label="Total budget" value={<Money cents={d.budget.totalCents} />} />
                  <Row label="Spent" value={<Money cents={d.budget.spentCents} />} />
                  <Row label="Reserved" value={<Money cents={d.budget.reservedCents} />} />
                  <Row label="Remaining" value={<Money cents={d.budget.remainingCents} />} />
                </div>
              </Section>

              <Section
                title="Delivery"
                description="Scheduled / published / failed / cancelled counts, plus the run success rate."
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
                description="Measured impressions and clicks. These come from delivery measurement, not a channel-reported view figure."
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

function deliveryRows(d: CampaignAnalyticsDetail): MetricRow[] {
  return [
    { key: 'scheduled', label: 'Scheduled', value: <span className="num">{groupNumber(d.delivery.scheduled)}</span> },
    { key: 'published', label: 'Published', value: <span className="num">{groupNumber(d.delivery.published)}</span> },
    { key: 'failed', label: 'Failed', value: <span className="num">{groupNumber(d.delivery.failed)}</span> },
    { key: 'cancelled', label: 'Cancelled', value: <span className="num">{groupNumber(d.delivery.cancelled)}</span> },
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

function reachRows(d: CampaignAnalyticsDetail): MetricRow[] {
  return [
    { key: 'channels', label: 'Channels reached', value: <span className="num">{groupNumber(d.reach.channels)}</span> },
    {
      key: 'impressions',
      label: 'Impressions (CPM-measured)',
      value: <span className="num">{groupNumber(d.reach.impressions)}</span>,
      note: 'Measured views on CPM campaigns — a genuine 0 for fixed-price campaigns.',
    },
    { key: 'clicks', label: 'Clicks', value: <span className="num">{groupNumber(d.reach.clicks)}</span>, note: 'Tracked link clicks.' },
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

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <dt className="text-mute shrink-0">{label}</dt>
      <dd className="font-medium text-right min-w-0 truncate">{value}</dd>
    </div>
  );
}

function NotFoundBlock({ message }: { message: string }) {
  return (
    <div className="py-12">
      <div className="flex flex-col items-center text-center">
        <span className="w-12 h-12 rounded-2xl bg-app border border-line text-mute flex items-center justify-center mb-3">
          <Icon name="alert" size={22} />
        </span>
        <p className="font-semibold text-sm">Campaign not found</p>
        <p className="text-xs text-mute max-w-md mt-1">{message}</p>
        <Link
          to="/admin/campaigns"
          className="mt-4 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-ink text-app text-sm font-medium"
        >
          <Icon name="back" size={15} />
          Back to campaigns
        </Link>
      </div>
    </div>
  );
}

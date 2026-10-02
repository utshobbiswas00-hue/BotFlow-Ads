/**
 * Revenue — platform fee per UTC day.
 *
 * `GET /admin/analytics/revenue?days=` clamps `days` to 1…366 server-side, so the
 * range picker only offers values inside that window. Revenue is the fee booked
 * on PUBLISHED posts: money the platform actually earned, not money held in
 * escrow.
 *
 * The day-by-day table is shown in reverse so the newest day is first — the API
 * returns ascending order, and an operator reading a table top-down expects the
 * recent past at the top. The chart keeps the API order, because a time axis has
 * to run forwards.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { groupNumber } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Money } from '../../components/ui/Money';
import { LineChart } from '../../components/charts/LineChart';
import { getRevenue } from '../lib/api';
import { AdminPageHeader, KpiGrid, KpiTile, Section } from '../components/Kpi';
import { DataTable, Mono, type Column } from '../components/DataTable';
import { QueryState } from '../components/StateBlock';
import type { RevenueDay } from '../lib/types';

const RANGES = [7, 30, 90, 180, 365];

export function AdminAnalyticsPage() {
  const [days, setDays] = useState(30);

  const query = useQuery({
    queryKey: [...qk.adminRevenue, days],
    queryFn: () => getRevenue(days),
  });

  const byDay = query.data?.byDay ?? [];
  const total = byDay.reduce((sum, d) => sum + d.revenueCents, 0);
  const best = byDay.reduce<RevenueDay | null>(
    (acc, d) => (acc === null || d.revenueCents > acc.revenueCents ? d : acc),
    null,
  );
  const activeDays = byDay.filter((d) => d.revenueCents > 0).length;

  const columns: Column<RevenueDay>[] = [
    { key: 'date', header: 'UTC day', render: (d) => <Mono>{d.date}</Mono> },
    {
      key: 'revenue',
      header: 'Platform fee',
      align: 'right',
      nowrap: true,
      render: (d) => <Money cents={d.revenueCents} />,
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Revenue"
        description="Platform fee booked on posts that published, per UTC day."
        actions={
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
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
          </div>
        }
      />

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        skeletonRows={3}
      >
        <div className="space-y-6">
          <KpiGrid className="lg:grid-cols-3">
            <KpiTile label={`Total, last ${days}d`} value={<Money cents={total} />} icon="chart" />
            <KpiTile
              label="Days with revenue"
              value={`${activeDays} / ${byDay.length}`}
              sub={`${byDay.length - activeDays} zero days`}
              icon="clock"
            />
            <KpiTile
              label="Best day"
              value={best ? <Money cents={best.revenueCents} /> : '—'}
              sub={best ? best.date : undefined}
              icon="star"
              tone={best && best.revenueCents > 0 ? 'good' : 'neutral'}
            />
          </KpiGrid>

          <Section title="Daily revenue">
            <div className="bg-surface border border-line rounded-2xl p-3">
              <LineChart
                kind="money"
                height={280}
                data={byDay.map((d) => ({ label: d.date.slice(5), value: d.revenueCents }))}
              />
            </div>
          </Section>

          <Section title="Day by day" description={`${groupNumber(byDay.length)} days, newest first.`}>
            <DataTable
              rows={[...byDay].reverse()}
              columns={columns}
              rowKey={(d) => d.date}
              emptyTitle="No revenue recorded"
              emptyMessage="No post has been published with a platform fee in this window."
            />
          </Section>
        </div>
      </QueryState>
    </>
  );
}

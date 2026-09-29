import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { QueryObserverResult } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { isLimitError, limitMessage } from '../lib/errors';
import { compactNumber, formatDate, formatMoney } from '../lib/format';
import { qk } from '../lib/queryClient';
import type { AdvertiserHistory, MetricBadge, MetricsResponse } from '../lib/contracts';
import { usePremiumMe } from '../hooks/usePremium';
import { MetricSection } from '../components/domain/MetricRow';
import { UpgradePrompt } from '../components/domain/PremiumUI';
import { LineChart } from '../components/charts/LineChart';
import { Card, CardTitle } from '../components/ui/Card';
import { Tabs } from '../components/ui/Tabs';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { cn } from '../lib/cn';

type MetricsTab = 'advertiser' | 'publisher';

const SECTIONS = [
  { key: 'tracked', title: 'Tracked by BotFlow', subtitle: 'Measured by us directly. Exact.' },
  { key: 'reported', title: 'Reported by Telegram', subtitle: 'Only what the Telegram API actually returned for your posts.' },
  { key: 'estimated', title: 'Estimated', subtitle: 'Derived from channel history. Not measured — never treat these as results.' },
] as const;

const LEGEND_CHIP: Record<string, string> = {
  tracked: 'bg-brand text-white border border-brand',
  reported: 'bg-surface text-mute border border-line',
  estimated: 'bg-transparent text-mute border border-dashed border-line/80 opacity-75',
};

export function AnalyticsPage() {
  const [tab, setTab] = useState<MetricsTab>('advertiser');

  const adv = useQuery({
    queryKey: qk.metricsAdv,
    queryFn: (): Promise<MetricsResponse> => api.get<MetricsResponse>('/api/metrics/advertiser'),
  });
  const pub = useQuery({
    queryKey: qk.metricsPub,
    queryFn: (): Promise<MetricsResponse> => api.get<MetricsResponse>('/api/metrics/publisher'),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Analytics</h1>
        <p className="text-sm text-mute">What we measure, what Telegram reports, and what is only an estimate.</p>
      </div>

      <Tabs
        items={[
          { value: 'advertiser', label: 'Advertiser' },
          { value: 'publisher', label: 'Publisher' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as MetricsTab)}
        className="-mx-4 px-4"
      />

      {tab === 'advertiser' ? (
        <div className="space-y-5">
          <MetricsView q={adv} />
          <HistorySection />
        </div>
      ) : (
        <MetricsView q={pub} />
      )}
    </div>
  );
}

/* ---------- Premium: per-day history + top channels ---------- */

const HISTORY_RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

/**
 * The `advancedAnalytics` ability, made visible.
 *
 * Premium unlocks `GET /api/analytics/advertiser/history` (per-day views,
 * clicks and spend plus the best channels in the window). A free advertiser is
 * refused by the backend with a 403 that carries an upgrade message
 * (backend/src/services/analytics.service.ts:155) — that refusal is shown as an
 * upsell, never as an empty page.
 */
function HistorySection() {
  const [days, setDays] = useState('30');
  const premium = usePremiumMe();
  const entitled = premium.data?.entitlements?.advancedAnalytics === true;

  const history = useQuery({
    queryKey: [...qk.analyticsAdv, 'history', days],
    enabled: entitled,
    queryFn: (): Promise<AdvertiserHistory> =>
      api.get<AdvertiserHistory>('/api/analytics/advertiser/history', { days: Number(days) }),
  });

  if (!entitled) {
    return (
      <UpgradePrompt
        title="Daily history is part of Premium"
        message="Premium unlocks a 7, 30 or 90 day breakdown of views, clicks and spend, plus your best-performing channels in that window."
        actionLabel="Unlock with Premium"
      />
    );
  }

  if (history.isError) {
    if (isLimitError(history.error)) {
      return (
        <UpgradePrompt
          title="This report is part of Premium"
          message={limitMessage(history.error)}
          actionLabel="Unlock with Premium"
        />
      );
    }
    return <ErrorState message={limitMessage(history.error)} onRetry={() => void history.refetch()} />;
  }

  if (history.isPending) return <Skeleton className="h-56 w-full rounded-2xl" />;

  const d = history.data;
  if (!d) {
    return (
      <EmptyState
        icon="chart"
        title="No history yet"
        message="Per-day numbers appear once your campaigns have delivered posts."
      />
    );
  }

  const daily = d.daily ?? [];
  const topChannels = d.topChannels ?? [];
  const totals = d.totals ?? {};

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <CardTitle className="mb-0">Daily delivery</CardTitle>
        <span className="text-[11px] text-mute whitespace-nowrap">
          {d.from && d.to ? `${formatDate(d.from)} – ${formatDate(d.to)}` : `${d.days ?? days} days`}
        </span>
      </div>

      <Tabs items={HISTORY_RANGES} value={days} onChange={setDays} className="-mx-4 px-4" />

      <Card className="space-y-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="num text-lg font-bold">{compactNumber(totals.views ?? 0)}</p>
            <p className="text-xs text-mute">Views</p>
          </div>
          <div>
            <p className="num text-lg font-bold">{compactNumber(totals.clicks ?? 0)}</p>
            <p className="text-xs text-mute">Clicks</p>
          </div>
          <div>
            <p className="num text-lg font-bold">{typeof totals.ctr === 'number' ? `${totals.ctr}%` : '—'}</p>
            <p className="text-xs text-mute">CTR</p>
          </div>
        </div>
        <div className="flex items-center justify-between text-xs border-t border-line pt-3">
          <span className="text-mute">Tracked spend in this window</span>
          <span className="num font-semibold">{formatMoney(totals.spendCents ?? 0)}</span>
        </div>
        <LineChart
          data={daily.map((row) => ({ label: (row.date ?? '').slice(5), value: row.views ?? 0 }))}
          kind="number"
          height={170}
        />
      </Card>

      {topChannels.length > 0 && (
        <Card padded={false}>
          <div className="px-4 pt-4">
            <CardTitle>Best channels in this window</CardTitle>
          </div>
          <div className="divide-y divide-line">
            {topChannels.map((c) => (
              <div key={c.channelId} className="flex items-center gap-3 px-4 py-3">
                <p className="text-sm font-medium flex-1 min-w-0 truncate">{c.title || 'Channel'}</p>
                <p className="num text-xs text-mute whitespace-nowrap">
                  {compactNumber(c.views)} views · {compactNumber(c.clicks)} clicks
                </p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function MetricsView({ q }: { q: QueryObserverResult<MetricsResponse, Error> }) {
  if (q.isPending) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading metrics">
        {SECTIONS.map((s) => (
          <Skeleton key={s.key} className="h-36 w-full rounded-2xl" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    // A premium-only range/breakdown is refused with a limit error. That is an
    // upsell moment, not a failure — never an empty page and never a crash.
    if (isLimitError(q.error)) {
      return (
        <UpgradePrompt
          title="This report is part of Premium"
          message={limitMessage(q.error)}
          actionLabel="Unlock with Premium"
        />
      );
    }
    // Tolerate 404s (endpoint not deployed yet) — show a calm empty state, never crash.
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <EmptyState
          icon="chart"
          title="Metrics not available yet"
          message="Provenance-tagged metrics are not enabled on this deployment. Your wallet and campaign pages still show live numbers."
        />
      );
    }
    return <ErrorState message={limitMessage(q.error)} onRetry={() => void q.refetch()} />;
  }

  // A successful response with no body must still render something readable.
  const d = q.data;
  if (!d) {
    return (
      <EmptyState
        icon="chart"
        title="Nothing to show yet"
        message="There is no measured activity for this account yet. Numbers appear as soon as your first post is delivered."
      />
    );
  }

  const legend = d.legend;
  // The API returns `{ label, tone }` badge objects; older/other deployments
  // may return a plain string. Render a primitive either way (never an object).
  const legendText = (v?: MetricBadge | string): string | undefined =>
    typeof v === 'string' ? v : v?.label;
  const legendItems: Array<{ key: 'tracked' | 'reported' | 'estimated'; text?: MetricBadge | string }> = [
    { key: 'tracked', text: legend?.tracked },
    { key: 'reported', text: legend?.reported },
    { key: 'estimated', text: legend?.estimated },
  ];
  const hasLegend = legendItems.some((l) => legendText(l.text));

  return (
    <div className="space-y-5">
      {hasLegend && (
        <div className="space-y-1.5">
          {legendItems.map(
            (l) =>
              l.text && (
                <p key={l.key} className="text-xs text-mute flex items-start gap-2">
                  <span
                    className={cn(
                      'inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold tracking-wide uppercase shrink-0',
                      LEGEND_CHIP[l.key],
                    )}
                  >
                    {l.key}
                  </span>
                  <span className="leading-snug">{legendText(l.text)}</span>
                </p>
              ),
          )}
        </div>
      )}

      <MetricSection title={SECTIONS[0].title} subtitle={SECTIONS[0].subtitle} metrics={d.tracked ?? []} />
      <MetricSection title={SECTIONS[1].title} subtitle={SECTIONS[1].subtitle} metrics={d.reported ?? []} />
      <MetricSection title={SECTIONS[2].title} subtitle={SECTIONS[2].subtitle} metrics={d.estimated ?? []} />

      {d.note && (
        <p className="text-xs text-mute leading-relaxed bg-surface border border-line rounded-xl px-3.5 py-3">
          {d.note}
        </p>
      )}
    </div>
  );
}

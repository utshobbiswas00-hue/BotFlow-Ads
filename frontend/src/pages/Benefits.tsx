import { useState, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../lib/api';
import { humanError, isNotFoundError } from '../lib/errors';
import { compactNumber, groupNumber } from '../lib/format';
import { PageHeader } from '../components/layout/PageHeader';
import { Card, CardTitle } from '../components/ui/Card';
import { Money } from '../components/ui/Money';
import { StatCard } from '../components/charts/StatCard';
import { Tabs } from '../components/ui/Tabs';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';

/* ---------- API shapes (GET /api/benefits/*) ---------- */

export interface EarningsTableRow {
  views: number;
  viewsLabel: string;
  cents: number;
  amountLabel: string;
}

export interface SlotMix {
  paidPercent: number;
  housePercent: number;
  summary: string;
  publisherNote?: string;
}

export interface PublisherBenefits {
  headline: string;
  rateCents: number;
  rateLabel: string;
  perViewLabel: string;
  howItWorks: string[];
  earningsTable: EarningsTableRow[];
  slotMix: SlotMix;
  measurementNote: string;
  payoutTiming: string;
}

export interface AdvertiserExample {
  budgetCents: number;
  budgetLabel: string;
  promise: string;
  reachMin: number;
  reachMax: number;
}

export interface AdvertiserBenefits {
  headline: string;
  minimumBudgetCents: number;
  minimumBudgetLabel: string;
  examples: AdvertiserExample[];
  howItWorks: string[];
  slotMixNote: string;
  billingNote: string;
}

export interface BenefitsPerk {
  key: string;
  label: string;
  value: unknown;
  display: string;
}

export interface BenefitsMe {
  earnings: {
    measuredPosts: number;
    unmeasuredPosts: number;
    totalViews: number;
    totalCpmEarnedCents: number;
    rateCents: number;
    rateLabel: string;
  };
  perks: BenefitsPerk[];
}

/* ---------- helpers ---------- */

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** Shared loading state for a tab. */
function BenefitsSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-28 w-full rounded-2xl" />
      <Skeleton className="h-56 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  );
}

/** 404s are expected while the backend is not fully deployed — never an error screen. */
function NotAvailableState({ onRetry }: { onRetry: () => void }) {
  return (
    <EmptyState
      icon="info"
      title="Not available yet"
      message="This section is not published on this app yet. Check back soon."
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

function HowItWorks({ steps }: { steps: string[] }) {
  if (!steps.length) return null;
  return (
    <Card>
      <CardTitle>How it works</CardTitle>
      <ol className="space-y-2.5">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3 text-sm">
            <span className="num w-6 h-6 rounded-full bg-accent/10 text-accent text-xs font-bold flex items-center justify-center shrink-0">
              {i + 1}
            </span>
            <span className="pt-0.5 leading-snug">{step}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function NoteBlock({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-2xl bg-app border border-line p-3.5">
      <Icon name="info" size={16} className="text-mute shrink-0 mt-0.5" />
      <p className="text-xs text-mute leading-relaxed">{children}</p>
    </div>
  );
}

function SlotMixCard({ mix }: { mix: SlotMix }) {
  const paid = clampPercent(mix.paidPercent);
  const house = clampPercent(mix.housePercent);
  return (
    <Card className="border-accent/40 bg-accent/5">
      <CardTitle>How ad slots are split</CardTitle>
      <div className="flex gap-3 mb-3">
        <div className="flex-1 text-center rounded-xl bg-surface border border-line py-2.5">
          <p className="num text-lg font-bold text-accent">{mix.paidPercent}%</p>
          <p className="text-xs text-mute mt-0.5">Paid slots</p>
        </div>
        <div className="flex-1 text-center rounded-xl bg-surface border border-line py-2.5">
          <p className="num text-lg font-bold text-warn">{mix.housePercent}%</p>
          <p className="text-xs text-mute mt-0.5">House slots</p>
        </div>
      </div>
      <div className="flex h-2 rounded-full overflow-hidden bg-line/60 mb-3">
        <div className="bg-accent h-full" style={{ width: `${paid}%` }} />
        <div className="bg-warn h-full" style={{ width: `${house}%` }} />
      </div>
      <p className="text-sm leading-relaxed">{mix.summary}</p>
      {mix.publisherNote && <p className="text-xs text-mute mt-2 leading-relaxed">{mix.publisherNote}</p>}
    </Card>
  );
}

/* ---------- Publisher tab ---------- */

function PublisherTab({ q }: { q: UseQueryResult<PublisherBenefits, Error> }) {
  if (q.isLoading) return <BenefitsSkeleton />;
  if (q.isError) {
    if (isNotFoundError(q.error)) return <NotAvailableState onRetry={() => void q.refetch()} />;
    return <ErrorState message={humanError(q.error)} onRetry={() => void q.refetch()} />;
  }
  if (!q.data) return <NotAvailableState onRetry={() => void q.refetch()} />;
  return <PublisherContent data={q.data} />;
}

function PublisherContent({ data: d }: { data: PublisherBenefits }) {
  const [viewsInput, setViewsInput] = useState('');
  const views = Math.max(0, Math.floor(Number(viewsInput) || 0));
  const estCents = Math.round((views * d.rateCents) / 1000);

  return (
    <div className="space-y-3">
      {/* Headline on the brand hero */}
      <div className="brand-hero rounded-2xl p-5 shadow-kpi">
        <p className="text-xs font-semibold uppercase tracking-wider text-white/70">Publisher rate</p>
        <p className="text-2xl font-bold mt-1.5 leading-tight">{d.headline}</p>
        {(d.rateLabel || d.perViewLabel) && (
          <p className="text-sm text-white/85 mt-2">{[d.rateLabel, d.perViewLabel].filter(Boolean).join(' · ')}</p>
        )}
      </div>

      {/* Earnings table — always the pre-formatted labels, never raw cents */}
      {d.earningsTable.length > 0 && (
        <Card padded={false}>
          <div className="px-4 pt-4">
            <CardTitle>Earnings table</CardTitle>
            <div className="grid grid-cols-2 text-xs font-semibold text-mute uppercase tracking-wide pb-1">
              <span>Views</span>
              <span className="text-right">You earn</span>
            </div>
          </div>
          <div className="divide-y divide-line">
            {d.earningsTable.map((row) => (
              <div key={row.views} className="grid grid-cols-2 items-center px-4 py-3 text-sm">
                <span className="num text-mute">{row.viewsLabel}</span>
                <span className="num text-right font-bold">{row.amountLabel}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <HowItWorks steps={d.howItWorks} />

      <SlotMixCard mix={d.slotMix} />

      {/* Potential earnings calculator (client-side estimate) */}
      <Card className="space-y-3">
        <CardTitle>Potential earnings</CardTitle>
        <Input
          label="Expected views"
          type="number"
          inputMode="numeric"
          min={0}
          placeholder="e.g. 10000"
          value={viewsInput}
          onChange={(e) => setViewsInput(e.target.value)}
        />
        <div className="flex items-center justify-between rounded-xl bg-app px-3.5 py-3">
          <span className="text-sm text-mute">Estimated earnings</span>
          <Money cents={estCents} className="text-xl font-bold" />
        </div>
        <p className="text-[11px] text-mute -mt-1">
          Estimate only — real earnings depend on measured views and the paid/house slot mix.
        </p>
      </Card>

      <NoteBlock>{d.measurementNote}</NoteBlock>

      {d.payoutTiming && (
        <p className="flex items-center gap-1.5 text-xs text-mute px-1">
          <Icon name="clock" size={14} /> {d.payoutTiming}
        </p>
      )}
    </div>
  );
}

/* ---------- Advertiser tab ---------- */

function AdvertiserTab({ q }: { q: UseQueryResult<AdvertiserBenefits, Error> }) {
  if (q.isLoading) return <BenefitsSkeleton />;
  if (q.isError) {
    if (isNotFoundError(q.error)) return <NotAvailableState onRetry={() => void q.refetch()} />;
    return <ErrorState message={humanError(q.error)} onRetry={() => void q.refetch()} />;
  }
  if (!q.data) return <NotAvailableState onRetry={() => void q.refetch()} />;
  return <AdvertiserContent data={q.data} />;
}

function AdvertiserContent({ data: d }: { data: AdvertiserBenefits }) {
  return (
    <div className="space-y-3">
      <Card className="space-y-1.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-mute">For advertisers</p>
        <p className="text-xl font-bold leading-snug">{d.headline}</p>
        <p className="text-sm text-mute">Minimum budget: {d.minimumBudgetLabel}</p>
      </Card>

      {d.examples.length > 0 && (
        <div>
          <CardTitle>Example budgets</CardTitle>
          <div className="space-y-3">
            {d.examples.map((ex) => (
              <Card key={ex.budgetCents} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Money cents={ex.budgetCents} className="text-lg font-bold" />
                  <Icon name="chevronRight" size={16} className="text-mute shrink-0" />
                  <span className="num font-semibold text-[15px]">
                    {compactNumber(ex.reachMin)} – {compactNumber(ex.reachMax)} people
                  </span>
                </div>
                {ex.promise && <p className="text-xs text-mute leading-relaxed">{ex.promise}</p>}
              </Card>
            ))}
          </div>
        </div>
      )}

      <HowItWorks steps={d.howItWorks} />

      {d.slotMixNote && <NoteBlock>{d.slotMixNote}</NoteBlock>}
      {d.billingNote && <NoteBlock>{d.billingNote}</NoteBlock>}
    </div>
  );
}

/* ---------- "Your numbers" (GET /api/benefits/me) ---------- */

function YourNumbersCard({ q }: { q: UseQueryResult<BenefitsMe, Error> }) {
  if (q.isLoading) return <Skeleton className="h-44 w-full rounded-2xl" />;
  if (q.isError) {
    if (isNotFoundError(q.error)) return null;
    return <ErrorState message={humanError(q.error)} onRetry={() => void q.refetch()} />;
  }
  const d = q.data;
  if (!d) return null;
  const e = d.earnings;
  return (
    <Card>
      <CardTitle>Your numbers</CardTitle>
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Measured posts" value={groupNumber(e.measuredPosts)} icon={<Icon name="chart" size={16} />} />
        <StatCard label="Unmeasured posts" value={groupNumber(e.unmeasuredPosts)} icon={<Icon name="clock" size={16} />} />
        <StatCard label="Total views" value={groupNumber(e.totalViews)} icon={<Icon name="eye" size={16} />} />
        <StatCard
          label="Total earned"
          value={<Money cents={e.totalCpmEarnedCents} />}
          sub={e.rateLabel || undefined}
          icon={<Icon name="coin" size={16} />}
        />
      </div>
      {d.perks.length > 0 && (
        <div className="mt-3 pt-3 border-t border-line space-y-2">
          {d.perks.map((p) => (
            <div key={p.key} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-mute min-w-0">{p.label}</span>
              <span className="num font-medium text-right shrink-0">{p.display}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------- Page ---------- */

export function BenefitsPage() {
  const [tab, setTab] = useState<'publisher' | 'advertiser'>('publisher');

  const publisher = useQuery({
    queryKey: ['benefits', 'publisher'],
    queryFn: (): Promise<PublisherBenefits> => api.get<PublisherBenefits>('/api/benefits/publisher'),
  });
  const advertiser = useQuery({
    queryKey: ['benefits', 'advertiser'],
    queryFn: (): Promise<AdvertiserBenefits> => api.get<AdvertiserBenefits>('/api/benefits/advertiser'),
  });
  const me = useQuery({
    queryKey: ['benefits', 'me'],
    queryFn: (): Promise<BenefitsMe> => api.get<BenefitsMe>('/api/benefits/me'),
  });

  return (
    <>
      <PageHeader title="Benefits & earnings" subtitle="What this platform gives you" />
      <div className="space-y-4 mt-2">
        <Tabs
          items={[
            { value: 'publisher', label: 'Publishers' },
            { value: 'advertiser', label: 'Advertisers' },
          ]}
          value={tab}
          onChange={(v) => setTab(v === 'advertiser' ? 'advertiser' : 'publisher')}
        />
        {tab === 'publisher' ? <PublisherTab q={publisher} /> : <AdvertiserTab q={advertiser} />}
        <YourNumbersCard q={me} />
      </div>
    </>
  );
}

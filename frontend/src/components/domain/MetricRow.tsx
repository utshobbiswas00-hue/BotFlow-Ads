import type { Metric } from '../../lib/contracts';
import { cn } from '../../lib/cn';
import { groupNumber } from '../../lib/format';

/**
 * One metric line with an explicit provenance chip.
 *
 * Three DISTINCT chip tones so the reader can tell at a glance how the
 * number was obtained:
 *  - TRACKED    → solid, confident (we measured it)
 *  - REPORTED   → outlined (Telegram told us)
 *  - ESTIMATED  → dashed + muted (derived, do not treat as a result)
 *
 * A `null` value renders an em dash styled as unavailable — never a zero.
 */

const CHIP_CLS: Record<Metric['provenance'], string> = {
  TRACKED: 'bg-brand text-white border border-brand',
  REPORTED: 'bg-surface text-mute border border-line',
  ESTIMATED: 'bg-transparent text-mute border border-dashed border-line/80 opacity-75',
};

const CHIP_LABEL: Record<Metric['provenance'], string> = {
  TRACKED: 'Tracked',
  REPORTED: 'Reported',
  ESTIMATED: 'Estimated',
};

export function MetricRow({ metric, className }: { metric: Metric; className?: string }) {
  const available = metric.value !== null && metric.value !== undefined;
  return (
    <div className={cn('py-3 flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium leading-tight">{metric.label}</p>
          <span
            className={cn(
              'inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold tracking-wide uppercase',
              CHIP_CLS[metric.provenance],
            )}
          >
            {CHIP_LABEL[metric.provenance]}
          </span>
        </div>
        {metric.note && (
          <p className={cn('text-xs leading-snug mt-1', available ? 'text-mute/70' : 'text-mute')}>
            {metric.note}
          </p>
        )}
      </div>
      <p
        className={cn(
          'num shrink-0 text-base font-bold whitespace-nowrap',
          !available ? 'text-mute/50 font-semibold' : metric.provenance === 'ESTIMATED' ? 'text-mute' : 'text-ink',
        )}
      >
        {available ? groupNumber(metric.value as number) : '—'}
      </p>
    </div>
  );
}

/** Titled group of metric rows with an explanatory sub-heading. */
export function MetricSection({
  title,
  subtitle,
  metrics,
}: {
  title: string;
  subtitle: string;
  metrics: Metric[];
}) {
  return (
    <section>
      <div className="mb-2">
        <h2 className="text-[15px] font-bold leading-tight">{title}</h2>
        <p className="text-xs text-mute mt-0.5 leading-snug">{subtitle}</p>
      </div>
      <div className="bg-surface border border-line rounded-2xl px-4 divide-y divide-line">
        {metrics.length === 0 ? (
          <p className="py-4 text-sm text-mute">No metrics yet.</p>
        ) : (
          metrics.map((m) => <MetricRow key={m.key} metric={m} />)
        )}
      </div>
    </section>
  );
}

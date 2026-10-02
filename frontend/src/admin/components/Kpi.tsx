/**
 * KPI tiles, section wrappers and the page header used across the panel.
 *
 * `tone` is carried by an explicit label as well as colour — a tile always shows
 * its own text — so an operator never has to read a colour to know whether a
 * number needs attention.
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from '../../components/ui/icons';

export type KpiTone = 'neutral' | 'good' | 'warn' | 'bad';

const TONE_RING: Record<KpiTone, string> = {
  neutral: 'border-line',
  good: 'border-ok/40',
  warn: 'border-warn/40',
  bad: 'border-danger/40',
};

const TONE_TEXT: Record<KpiTone, string> = {
  neutral: 'text-ink',
  good: 'text-ok',
  warn: 'text-warn',
  bad: 'text-danger',
};

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  /** Small line under the value — a share, a date, or a hint. */
  sub?: ReactNode;
  icon?: IconName;
  tone?: KpiTone;
  onClick?: () => void;
}

export function KpiTile({ label, value, sub, icon, tone = 'neutral', onClick }: KpiTileProps) {
  const className = cn(
    'text-left bg-surface border rounded-2xl p-4 transition-colors w-full',
    TONE_RING[tone],
    onClick && 'hover:bg-app/60',
  );

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-mute font-semibold">{label}</span>
        {icon ? <Icon name={icon} size={16} className="text-mute shrink-0" /> : null}
      </div>
      <div className={cn('num text-2xl font-bold mt-2', TONE_TEXT[tone])}>{value}</div>
      {sub ? <div className="text-xs text-mute mt-1">{sub}</div> : null}
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}

export function KpiGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 lg:grid-cols-4 gap-3', className)}>{children}</div>;
}

/** Section wrapper: title + optional right-hand actions, then content. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? <p className="text-xs text-mute mt-0.5 max-w-3xl">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Page heading used at the top of every admin screen. */
export function AdminPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="text-xl font-bold">{title}</h1>
        {description ? <p className="text-sm text-mute mt-1 max-w-2xl">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

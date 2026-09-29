import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { formatDate } from '../../lib/format';
import { isPremiumActive, quotaAtLimit, quotaUsageText, tierLabel, normaliseQuota } from '../../lib/premium';
import type { PremiumMe, PremiumQuota } from '../../lib/premium';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Icon } from '../ui/icons';

/**
 * The small, reusable pieces that make the membership visible where it matters.
 * They read only from `GET /api/premium/me` (backend/src/routes/premium.routes.ts:96)
 * and render nothing rather than something wrong when a field is missing.
 */

/**
 * A subscriber's tier chip. Renders nothing at all for a free account, so the
 * dashboard never grows a "you are not premium" nag it did not ask for.
 */
export function PremiumBadge({
  me,
  withExpiry = false,
  className,
}: {
  me?: PremiumMe | null;
  withExpiry?: boolean;
  className?: string;
}) {
  if (!isPremiumActive(me)) return null;
  const tier = tierLabel(me?.tier);
  const expiresAt = me?.subscription?.expiresAt ?? null;
  return (
    <Link
      to="/premium"
      title={expiresAt ? `${tier} · active until ${formatDate(expiresAt)}` : tier}
      className={cn(
        'inline-flex items-center gap-1 h-6 px-2 rounded-full bg-accent/10 text-accent text-[11px] font-bold whitespace-nowrap shrink-0',
        className,
      )}
    >
      <Icon name="shield" size={12} />
      {tier}
      {withExpiry && expiresAt && (
        <span className="font-medium text-accent/80">· until {formatDate(expiresAt)}</span>
      )}
    </Link>
  );
}

/**
 * One gate's live usage: "2 of 3 used · 1 left" plus a bar. Amber at the last
 * slot, red once the gate is closed. `-1` renders as Unlimited.
 */
export function QuotaMeter({
  label,
  quota,
  className,
}: {
  label: string;
  quota?: Partial<PremiumQuota> | null;
  className?: string;
}) {
  const q = normaliseQuota(quota);
  if (!q) return null;

  const unlimited = q.limit < 0;
  const full = quotaAtLimit(q);
  const low = !unlimited && !full && q.remaining <= 1;
  const pct = unlimited ? 4 : Math.min(100, Math.round((q.used / Math.max(q.limit, 1)) * 100));

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3 text-xs mb-1.5">
        <span className="font-medium truncate">{label}</span>
        <span className={cn('num whitespace-nowrap', full ? 'text-danger font-semibold' : low ? 'text-warn font-semibold' : 'text-mute')}>
          {quotaUsageText(q)}
        </span>
      </div>
      <div className="h-2 rounded-full bg-line/60 overflow-hidden">
        <div
          className={cn('h-full rounded-full', full ? 'bg-danger' : low ? 'bg-warn' : 'bg-accent')}
          style={{ width: `${pct}%` }}
        />
      </div>
      {q.message && <p className={cn('text-xs mt-1.5', full ? 'text-danger' : 'text-mute')}>{q.message}</p>}
    </div>
  );
}

/**
 * The tasteful upsell: one card, one sentence, one button to the plan page.
 * `message` should carry the backend's own reason whenever we have one.
 */
export function UpgradePrompt({
  title = 'Upgrade to Premium',
  message,
  actionLabel = 'See Premium plans',
  className,
  children,
}: {
  title?: string;
  message?: string;
  actionLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Card className={cn('space-y-3', className)}>
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-xl bg-accent/10 text-accent flex items-center justify-center shrink-0">
          <Icon name="shield" size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          {message && <p className="text-xs text-mute mt-0.5 leading-relaxed">{message}</p>}
        </div>
      </div>
      {children}
      <Link to="/premium" className="block">
        <Button full size="sm" icon={<Icon name="arrowUp" size={15} />}>
          {actionLabel}
        </Button>
      </Link>
    </Card>
  );
}

/**
 * The upgrade prompt shown when a gate actually refuses the action, carrying
 * the API's exact sentence so the user knows which limit they hit.
 */
export function LimitUpgradePrompt({
  title,
  message,
  className,
}: {
  title: string;
  message: string;
  className?: string;
}) {
  return (
    <UpgradePrompt
      title={title}
      message={message}
      actionLabel="Upgrade to Premium"
      className={cn('border-accent/40 bg-accent/5', className)}
    />
  );
}

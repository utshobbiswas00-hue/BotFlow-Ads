import { cn } from '../../lib/cn';
import { humanize } from '../../lib/format';

type Tone = 'green' | 'blue' | 'amber' | 'red' | 'gray' | 'purple';

const TONE_CLS: Record<Tone, string> = {
  green: 'bg-ok/10 text-ok',
  blue: 'bg-accent/10 text-link',
  amber: 'bg-warn/10 text-warn',
  red: 'bg-danger/10 text-danger',
  gray: 'bg-mute/10 text-mute',
  purple: 'bg-purple-500/10 text-purple-500',
};

const STATUS_TONE: Record<string, Tone> = {
  // campaigns / generic
  RUNNING: 'green',
  APPROVED: 'green',
  COMPLETED: 'green',
  PAID: 'green',
  VERIFIED: 'green',
  AVAILABLE: 'green',
  ACTIVE: 'green',
  SCHEDULED: 'blue',
  PENDING_REVIEW: 'amber',
  PENDING: 'amber',
  PROCESSING: 'amber',
  IN_PROGRESS: 'amber',
  LOCKED: 'amber',
  AWAITING_APPROVAL: 'amber',
  RETRYING: 'amber',
  REVIEWING: 'amber',
  DRAFT: 'gray',
  PAUSED: 'amber',
  SUSPENDED: 'red',
  REJECTED: 'red',
  FAILED: 'red',
  CANCELLED: 'gray',
  EXPIRED: 'gray',
  SKIPPED: 'gray',
  REVERSED: 'gray',
  DISMISSED: 'gray',
  CLOSED: 'gray',
  // channels
  INACTIVE: 'gray',
  ATTENTION_REQUIRED: 'red',
  // tickets / reports / notifications
  OPEN: 'blue',
  RESOLVED: 'green',
  // ad posts
  QUEUED: 'amber',
  PUBLISHED: 'green',
  DELETED: 'gray',
  // deposits
  // withdrawals
  // referrals
  REFUNDED: 'blue',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = STATUS_TONE[status] ?? 'gray';
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold tracking-wide whitespace-nowrap',
        TONE_CLS[tone],
        className,
      )}
    >
      {humanize(status)}
    </span>
  );
}

import type { TransactionRow as TransactionRowType } from '@botflow/shared';
import { formatDateTime, humanize } from '../../lib/format';
import { Money } from '../ui/Money';
import { StatusBadge } from '../ui/StatusBadge';

/** Inflows that should be shown as green positive amounts. */
const CREDIT_TYPES = new Set([
  'DEPOSIT',
  'PUBLISHER_EARNING',
  'REFUND',
  'REFERRAL_REWARD',
  'ESCROW_RELEASE',
]);

export interface TransactionRowProps {
  row: TransactionRowType;
}

/** One row in the transactions list. */
export function TransactionRow({ row }: TransactionRowProps) {
  const credit = CREDIT_TYPES.has(row.type);
  const displayCents = credit ? row.amountCents : -row.amountCents;
  return (
    <div className="bg-surface border border-line rounded-2xl p-3.5 flex items-center gap-3">
      <div
        className={`w-10 h-10 rounded-full flex items-center justify-center text-base shrink-0 ${
          credit ? 'bg-ok/10 text-ok' : 'bg-mute/10 text-mute'
        }`}
        aria-hidden
      >
        {credit ? '↓' : '↑'}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate">{humanize(row.type)}</p>
        <p className="text-xs text-mute truncate">
          {row.description || row.reference} · {formatDateTime(row.createdAt)}
        </p>
      </div>
      <div className="text-right shrink-0">
        <Money cents={displayCents} currency={row.currency} signed className="text-sm font-bold" />
        <div className="mt-0.5">
          <StatusBadge status={row.status} />
        </div>
      </div>
    </div>
  );
}

import type { WalletSummary } from '@botflow/shared';
import { Money } from '../ui/Money';
import { cn } from '../../lib/cn';

export interface BalanceCardProps {
  wallet: WalletSummary;
  compact?: boolean;
  className?: string;
}

/**
 * Wallet summary card.
 *
 * The hero uses the BotFlow brand gradient rather than the Telegram button
 * colour: this is the one surface where the product's own identity should win.
 * Everything around it still follows the Telegram theme.
 */
export function BalanceCard({ wallet, compact = false, className }: BalanceCardProps) {
  const c = wallet.currency;

  return (
    <div className={cn('brand-hero rounded-2xl p-4 shadow-kpi', className)}>
      <p className="text-white/75 text-xs font-medium mb-1">Available balance</p>
      <p className="text-3xl font-extrabold tracking-tight animate-countup">
        <Money cents={wallet.availableCents} currency={c} className="text-white" />
      </p>

      {!compact && (
        <div className="grid grid-cols-2 gap-2 mt-4 text-[13px]">
          <div className="bg-white/10 rounded-xl px-3 py-2 backdrop-blur-sm">
            <p className="text-white/70 text-[11px]">Pending</p>
            <p className="font-semibold">
              <Money cents={wallet.pendingCents} currency={c} className="text-white" />
            </p>
          </div>
          <div className="bg-white/10 rounded-xl px-3 py-2 backdrop-blur-sm">
            <p className="text-white/70 text-[11px]">Reserved</p>
            <p className="font-semibold">
              <Money cents={wallet.reservedCents} currency={c} className="text-white" />
            </p>
          </div>
          <div className="bg-white/10 rounded-xl px-3 py-2 backdrop-blur-sm">
            <p className="text-white/70 text-[11px]">Total earned</p>
            <p className="font-semibold">
              <Money cents={wallet.totalEarnedCents} currency={c} className="text-white" />
            </p>
          </div>
          <div className="bg-white/10 rounded-xl px-3 py-2 backdrop-blur-sm">
            <p className="text-white/70 text-[11px]">Total spent</p>
            <p className="font-semibold">
              <Money cents={wallet.totalSpentCents} currency={c} className="text-white" />
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

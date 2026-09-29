import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Paginated, TransactionRow } from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import { useBalance } from '../hooks/useBalance';
import { usePremiumMe } from '../hooks/usePremium';
import { BalanceCard } from '../components/domain/BalanceCard';
import { PremiumBadge } from '../components/domain/PremiumUI';
import { TransactionRow as TransactionRowView } from '../components/domain/TransactionRow';
import { Card, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { ErrorState } from '../components/ui/EmptyState';
import { ListSkeleton, Skeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';

export function WalletPage() {
  const { data: wallet, isPending } = useBalance();

  /* The wallet is where a subscriber pays from, so the tier belongs here too. */
  const premium = usePremiumMe();

  const txs = useQuery({
    queryKey: [...qk.transactions, { page: 1, limit: 5, type: 'all' }],
    queryFn: (): Promise<Paginated<TransactionRow>> =>
      api.get<Paginated<TransactionRow>>('/api/transactions', { page: 1, limit: 5 }),
  });

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">Wallet</h1>
          <PremiumBadge me={premium.data} withExpiry />
        </div>
        <p className="text-sm text-mute">Your balance and money movements.</p>
      </div>

      {isPending ? (
        <Skeleton className="h-28 w-full rounded-2xl" />
      ) : wallet ? (
        <BalanceCard wallet={wallet} />
      ) : null}

      <div className="grid grid-cols-3 gap-2.5">
        <Link to="/wallet/deposit" className="bg-surface border border-line rounded-2xl p-3 flex flex-col items-center gap-1.5 active:opacity-80">
          <span className="w-9 h-9 rounded-xl bg-ok/10 text-ok flex items-center justify-center">
            <Icon name="arrowDown" size={18} />
          </span>
          <span className="text-xs font-medium">Deposit</span>
        </Link>
        <Link to="/wallet/withdraw" className="bg-surface border border-line rounded-2xl p-3 flex flex-col items-center gap-1.5 active:opacity-80">
          <span className="w-9 h-9 rounded-xl bg-accent/10 text-accent flex items-center justify-center">
            <Icon name="arrowUp" size={18} />
          </span>
          <span className="text-xs font-medium">Withdraw</span>
        </Link>
        <Link to="/referrals" className="bg-surface border border-line rounded-2xl p-3 flex flex-col items-center gap-1.5 active:opacity-80">
          <span className="w-9 h-9 rounded-xl bg-warn/10 text-warn flex items-center justify-center">
            <Icon name="user" size={18} />
          </span>
          <span className="text-xs font-medium">Referrals</span>
        </Link>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-mute uppercase tracking-wide">Recent transactions</h3>
          <Link to="/transactions" className="text-sm text-link font-medium">
            View all
          </Link>
        </div>
        {txs.isLoading ? (
          <ListSkeleton rows={3} />
        ) : txs.isError ? (
          <ErrorState message={errMsg(txs.error)} onRetry={() => void txs.refetch()} />
        ) : txs.data && txs.data.items.length > 0 ? (
          <div className="space-y-3">
            {txs.data.items.map((t) => (
              <TransactionRowView key={t.id} row={t} />
            ))}
          </div>
        ) : (
          <Card>
            <p className="text-sm text-mute text-center py-4">
              No transactions yet.
            </p>
          </Card>
        )}
      </div>

      {wallet && wallet.availableCents === 0 && (
        <Card className="flex items-center gap-3">
          <Icon name="info" size={18} className="text-link shrink-0" />
          <p className="text-xs text-mute">
            Top up your wallet to launch campaigns, or connect a channel to start earning.
          </p>
        </Card>
      )}
      {wallet && (
        <p className="text-center text-[11px] text-mute pb-2">
          Currency: {wallet.currency} · deposits verified within 24h
        </p>
      )}
    </div>
  );
}

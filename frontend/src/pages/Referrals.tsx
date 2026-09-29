import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import type { ReferralsResponse } from '../lib/contracts';
import { formatDate, formatMoney, humanize } from '../lib/format';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Money } from '../components/ui/Money';
import { ErrorState } from '../components/ui/EmptyState';
import { ListSkeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';
import { showToast } from '../store/uiStore';

export function ReferralsPage() {
  const q = useQuery({
    queryKey: qk.referrals,
    queryFn: (): Promise<ReferralsResponse> => api.get<ReferralsResponse>('/api/referrals'),
  });

  const copyCode = async (): Promise<void> => {
    const code = q.data?.referralCode ?? '';
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast('success', 'Referral code copied');
    } catch {
      showToast('info', `Your code: ${code}`);
    }
  };

  const items = q.data?.referrals.items ?? [];

  return (
    <>
      <PageHeader title="Referrals" subtitle="Earn 10% of your friends' earnings" />

      <div className="space-y-4 mt-2">
        {/* Code card */}
        <Card className="bg-gradient-to-br from-accent to-accent/80 border-0 text-center">
          <p className="text-white/75 text-xs font-medium">Your referral code</p>
          {q.isLoading ? (
            <div className="h-10 w-40 mx-auto mt-2 rounded-lg bg-white/20 animate-pulse" />
          ) : (
            <p className="text-3xl font-extrabold tracking-widest text-white mt-1">{q.data?.referralCode ?? '—'}</p>
          )}
          <Button variant="secondary" size="sm" className="mt-4 bg-white/90" onClick={() => void copyCode()} icon={<Icon name="copy" size={15} />}>
            Copy code
          </Button>
          {q.data && (
            <p className="text-white/70 text-[11px] mt-3">
              {q.data.totalReferrals} friends · {formatMoney(q.data.totalRewardedCents)} earned
            </p>
          )}
        </Card>

        {/* How it works */}
        <Card className="space-y-2">
          <h3 className="text-sm font-semibold">How it works</h3>
          <ol className="text-sm text-mute space-y-1.5 list-decimal list-inside">
            <li>Share your code or referral link with friends.</li>
            <li>When they register via your code, you earn 10% of their earnings forever.</li>
            <li>Rewards are added to your wallet automatically.</li>
          </ol>
        </Card>

        {/* List */}
        <div>
          <h3 className="text-sm font-semibold text-mute uppercase tracking-wide mb-2">Your referrals</h3>
          {q.isLoading ? (
            <ListSkeleton rows={3} />
          ) : q.isError ? (
            <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
          ) : items.length === 0 ? (
            <Card>
              <p className="text-sm text-mute text-center py-4">No referrals yet — share your code to start earning.</p>
            </Card>
          ) : (
            <Card padded={false} className="divide-y divide-line">
              {items.map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-3 p-3.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-accent/10 text-accent flex items-center justify-center font-bold text-sm shrink-0">
                      {(r.name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{r.name || 'User'}</p>
                      <p className="text-xs text-mute">{formatDate(r.createdAt)}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-ok">
                      <Money cents={r.rewardCents} />
                    </p>
                    <StatusBadge status={r.status} className="mt-0.5" />
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

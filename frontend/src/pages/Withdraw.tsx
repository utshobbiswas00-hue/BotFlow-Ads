import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Paginated, WalletSummary } from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import type { WithdrawalRow } from '../lib/contracts';
import { formatDateTime, formatMoney, humanize } from '../lib/format';
import { useInvalidateBalance, type WalletResponse } from '../hooks/useBalance';
import { PageHeader } from '../components/layout/PageHeader';
import { Card, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { StatusBadge } from '../components/ui/StatusBadge';
import { ErrorState } from '../components/ui/EmptyState';
import { ListSkeleton, Skeleton } from '../components/ui/Skeleton';
import { Money } from '../components/ui/Money';
import { Icon } from '../components/ui/icons';
import { showToast } from '../store/uiStore';

const MIN_WITHDRAW_CENTS = 500;
const MAX_WITHDRAW_CENTS = 200000;

/**
 * Parse a user-entered amount ("19.99") into integer cents using string
 * arithmetic. `Math.round(parseFloat(x) * 100)` is unsafe on money — 19.99 * 100
 * is 1998.9999999999998 — and is banned across the codebase.
 */
function toCents(value: string): number {
  const match = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(value);
  if (!match) return NaN;
  const whole = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  let cents = whole * 100 + Number(fraction.slice(0, 2));
  if (fraction.length > 2 && Number(fraction[2]) >= 5) cents += 1;
  return cents;
}

export function WithdrawPage() {
  const qc = useQueryClient();
  const invalidateBalance = useInvalidateBalance();

  const [amount, setAmount] = useState('');
  const method = 'crypto';
  const [accountDetails, setAccountDetails] = useState('');
  const [network, setNetwork] = useState('TRC20');
  const [formError, setFormError] = useState<string | null>(null);

  const walletQ = useQuery({
    queryKey: qk.wallet,
    // The route returns `{ wallet, ... }` — the wallet is NOT the top level.
    queryFn: async (): Promise<WalletSummary> => {
      const data = await api.get<WalletResponse>('/api/wallet');
      return data.wallet;
    },
  });
  const wallet = walletQ.data;

  const request = useMutation({
    mutationFn: (body: Record<string, unknown>): Promise<WithdrawalRow> =>
      api.post<WithdrawalRow>('/api/withdrawals', body),
    onSuccess: (d) => {
      showToast('success', `Withdrawal of ${formatMoney(d.amountCents)} requested`);
      void qc.invalidateQueries({ queryKey: qk.withdrawals });
      invalidateBalance();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const history = useQuery({
    queryKey: [...qk.withdrawals, { page: 1, limit: 10 }],
    queryFn: (): Promise<Paginated<WithdrawalRow>> =>
      api.get<Paginated<WithdrawalRow>>('/api/withdrawals', { page: 1, limit: 10 }),
  });

  const availableCents = wallet?.availableCents ?? 0;
  const detailLabel = 'Wallet address';

  const submit = (): void => {
    const cents = toCents(amount);
    if (!Number.isFinite(cents) || cents < MIN_WITHDRAW_CENTS) {
      setFormError(`Minimum withdrawal is ${formatMoney(MIN_WITHDRAW_CENTS)}`);
      return;
    }
    if (cents > MAX_WITHDRAW_CENTS) {
      setFormError(`Maximum single withdrawal is ${formatMoney(MAX_WITHDRAW_CENTS)}`);
      return;
    }
    if (cents > availableCents) {
      setFormError(`Amount exceeds available balance (${formatMoney(availableCents)})`);
      return;
    }
    if (!accountDetails.trim()) {
      setFormError(`Enter your ${detailLabel.toLowerCase()}`);
      return;
    }
    // The API expects the crypto wallet address and network inside accountDetails.
    const details: Record<string, string> = {
      address: accountDetails.trim(),
      network,
    };
    request.mutate({
      amountCents: cents,
      method,
      accountDetails: details,
    });
  };

  return (
    <>
      <PageHeader title="Withdraw" back />

      <div className="space-y-4 mt-2">
        <Card className="space-y-4">
          {walletQ.isLoading ? (
            <Skeleton className="h-6 w-40" />
          ) : wallet ? (
            <div className="flex items-center justify-between bg-app rounded-xl px-3.5 py-3">
              <span className="text-sm text-mute">Available to withdraw</span>
              <span className="font-bold">
                <Money cents={availableCents} currency={wallet.currency} />
              </span>
            </div>
          ) : null}

          <Input
            label="Amount"
            type="number"
            inputMode="decimal"
            prefix="$"
            placeholder="25"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setFormError(null);
            }}
            hint={`Min ${formatMoney(MIN_WITHDRAW_CENTS)} · max ${formatMoney(MAX_WITHDRAW_CENTS)}`}
          />
          <div className="rounded-xl border border-line p-3">
            <p className="text-sm text-mute">Payout method</p>
            <p className="font-semibold">Crypto (USDT/USDC)</p>
          </div>
          <Input
            label={detailLabel}
            placeholder="T… / 0x…"
            value={accountDetails}
            onChange={(e) => {
              setAccountDetails(e.target.value);
              setFormError(null);
            }}
          />
          {method === 'crypto' && (
            <Select
              label="Network"
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
              options={[
                { value: 'TRC20', label: 'TRC20 (Tron)' },
                { value: 'ERC20', label: 'ERC20 (Ethereum)' },
                { value: 'BEP20', label: 'BEP20 (BSC)' },
              ]}
            />
          )}
          {formError && (
            <div className="flex items-center gap-2 text-sm text-danger">
              <Icon name="alert" size={16} /> {formError}
            </div>
          )}
          <Button full size="lg" loading={request.isPending} onClick={submit} icon={<Icon name="arrowUp" size={18} />}>
            Request withdrawal
          </Button>
          <p className="text-[11px] text-mute text-center">
            Withdrawals are processed within 24–72h. A small processing fee may apply.
          </p>
        </Card>

        <div>
          <CardTitle>Withdrawal history</CardTitle>
          {history.isLoading ? (
            <ListSkeleton rows={3} />
          ) : history.isError ? (
            <ErrorState message={errMsg(history.error)} onRetry={() => void history.refetch()} />
          ) : history.data && history.data.items.length > 0 ? (
            <Card padded={false} className="divide-y divide-line">
              {history.data.items.map((w) => (
                <div key={w.id} className="p-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">
                        <Money cents={w.amountCents} /> · {humanize(w.method)}
                      </p>
                      <p className="text-xs text-mute">
                        {formatDateTime(w.createdAt)}
                        {w.netAmountCents !== w.amountCents ? ` · net ${formatMoney(w.netAmountCents)}` : ''}
                      </p>
                    </div>
                    <StatusBadge status={w.status} />
                  </div>
                  {w.status === 'REJECTED' && w.rejectReason && (
                    <p className="text-xs text-danger mt-1.5">Reason: {w.rejectReason}</p>
                  )}
                </div>
              ))}
            </Card>
          ) : (
            <Card>
              <p className="text-sm text-mute text-center py-4">No withdrawals yet.</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

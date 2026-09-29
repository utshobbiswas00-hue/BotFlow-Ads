import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { qk } from '../lib/queryClient';
import { useUserStore } from '../store/userStore';
import type { WalletSummary } from '@botflow/shared';

/**
 * The real shape of `GET /api/wallet`: the wallet plus derived figures. The
 * route wraps the wallet in this envelope, so reading the top level as the
 * wallet itself yielded `undefined` balances (`$NaN`) everywhere.
 */
export interface WalletResponse {
  wallet: WalletSummary;
  withdrawableCents: number;
  netWorthCents: number;
  pendingEarningsCents: number;
}

/** Live wallet balance (GET /api/wallet). */
export function useBalance(enabled: boolean = true) {
  return useQuery({
    queryKey: qk.wallet,
    enabled,
    queryFn: async (): Promise<WalletSummary> => {
      const { wallet } = await api.get<WalletResponse>('/api/wallet');
      useUserStore.getState().setWallet(wallet);
      return wallet;
    },
  });
}

/** Mutations that spend/earn money should call this to refresh the balance. */
export function useInvalidateBalance() {
  const qc = useQueryClient();
  return (): void => {
    void qc.invalidateQueries({ queryKey: qk.wallet });
    void qc.invalidateQueries({ queryKey: qk.transactions });
    void qc.invalidateQueries({ queryKey: qk.dashboard });
  };
}

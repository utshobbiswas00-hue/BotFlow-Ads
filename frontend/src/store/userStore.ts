import { create } from 'zustand';
import type { UserProfile, WalletSummary } from '@botflow/shared';
import type { MeResponse } from '../lib/contracts';

interface UserState {
  user: UserProfile | null;
  wallet: WalletSummary | null;
  isAdmin: boolean;
  adminRole: string | null;
  sessionLoaded: boolean;
  setSession: (s: MeResponse) => void;
  setWallet: (w: WalletSummary) => void;
  reset: () => void;
}

export const useUserStore = create<UserState>((set) => ({
  user: null,
  wallet: null,
  isAdmin: false,
  adminRole: null,
  sessionLoaded: false,
  setSession: (s) =>
    set({
      user: s.user,
      wallet: s.wallet,
      isAdmin: s.isAdmin,
      adminRole: s.adminRole,
      sessionLoaded: true,
    }),
  setWallet: (w) => set({ wallet: w }),
  reset: () =>
    set({
      user: null,
      wallet: null,
      isAdmin: false,
      adminRole: null,
      sessionLoaded: false,
    }),
}));

/** Selectors (keep component re-renders cheap). */
export const selectUser = (s: UserState): UserProfile | null => s.user;
export const selectWallet = (s: UserState): WalletSummary | null => s.wallet;
export const selectIsAdmin = (s: UserState): boolean => s.isAdmin;

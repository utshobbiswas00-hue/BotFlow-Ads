import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { MeResponse } from '../lib/contracts';
import { qk } from '../lib/queryClient';
import { useUserStore } from '../store/userStore';

/**
 * Fetch /api/me and mirror the session into the zustand user store.
 * Use once near the app root (AppShell does this).
 */
export function useTelegramUser(enabled: boolean = true) {
  return useQuery({
    queryKey: qk.me,
    enabled,
    queryFn: async (): Promise<MeResponse> => {
      const data = await api.get<MeResponse>('/api/me');
      useUserStore.getState().setSession(data);
      return data;
    },
  });
}

/** Convenience: current session from the store (populated by useTelegramUser). */
export function useSession() {
  return useUserStore();
}

/**
 * Small static values the frontend has no other way to read (no build-time
 * env injection here) — currently just the bot's @username, needed to build
 * t.me deep links (e.g. "add this bot as admin"). Never changes without a
 * redeploy, so it is cached for the life of the session.
 */
export function useAppConfig() {
  return useQuery({
    queryKey: qk.appConfig,
    staleTime: Infinity,
    queryFn: (): Promise<{ botUsername: string }> => api.get('/api/app-config'),
  });
}

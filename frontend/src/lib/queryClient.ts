import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Global query client. Retries transient failures at most once, and never
 * retries 4xx client errors (bad input / auth — retrying is pointless).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          const status = error.status ?? 0;
          if (status >= 400 && status < 500) return false;
        }
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      gcTime: 5 * 60_000,
    },
    mutations: {
      retry: false,
    },
  },
});

/** Common query keys for cache invalidation. */
export const qk = {
  me: ['me'] as const,
  appConfig: ['app-config'] as const,
  wallet: ['wallet'] as const,
  channels: ['channels'] as const,
  channel: (id: string) => ['channels', id] as const,
  channelRequests: (id: string) => ['channels', id, 'requests'] as const,
  channelBlocklist: (id: string) => ['channels', id, 'blocklist'] as const,
  campaigns: ['campaigns'] as const,
  campaign: (id: string) => ['campaigns', id] as const,
  marketplace: ['marketplace'] as const,
  transactions: ['transactions'] as const,
  deposits: ['deposits'] as const,
  cryptoNetworks: ['deposits', 'crypto-networks'] as const,
  withdrawals: ['withdrawals'] as const,
  referrals: ['referrals'] as const,
  notifications: ['notifications'] as const,
  tickets: ['tickets'] as const,
  ticket: (id: string) => ['tickets', id] as const,
  analyticsAdv: ['analytics', 'advertiser'] as const,
  analyticsPub: ['analytics', 'publisher'] as const,
  metricsAdv: ['metrics', 'advertiser'] as const,
  metricsPub: ['metrics', 'publisher'] as const,
  unreadCount: ['notifications', 'unread-count'] as const,
  categoryPolicies: ['categories', 'policies'] as const,
  dashboard: ['dashboard'] as const,
  settingsPublic: ['settings', 'public'] as const,
  adminDashboard: ['admin', 'dashboard'] as const,
  adminCampaigns: ['admin', 'campaigns'] as const,
  adminChannels: ['admin', 'channels'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminDelivery: ['admin', 'delivery'] as const,
  adminDeposits: ['admin', 'finance', 'deposits'] as const,
  adminWithdrawals: ['admin', 'finance', 'withdrawals'] as const,
  adminRevenue: ['admin', 'analytics', 'revenue'] as const,
  adminReports: ['admin', 'moderation', 'reports'] as const,
  adminSettings: ['admin', 'settings'] as const,
};

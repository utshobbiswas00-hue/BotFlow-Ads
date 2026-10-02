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
  adminQueues: ['admin', 'dashboard', 'queues'] as const,
  adminCampaigns: ['admin', 'campaigns'] as const,
  adminChannels: ['admin', 'channels'] as const,
  adminBlockedAds: ['admin', 'channels', 'blocked'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminUser: (id: string) => ['admin', 'users', id] as const,
  adminDelivery: ['admin', 'delivery'] as const,
  adminDeliveryStats: ['admin', 'delivery', 'stats'] as const,
  adminDeposits: ['admin', 'finance', 'deposits'] as const,
  adminWithdrawals: ['admin', 'finance', 'withdrawals'] as const,
  adminTransactions: ['admin', 'finance', 'transactions'] as const,
  adminCryptoAddresses: ['admin', 'crypto-addresses'] as const,
  adminCryptoTransfers: ['admin', 'crypto-transfers'] as const,
  adminScannableNetworks: ['admin', 'crypto-transfers', 'scannable'] as const,
  adminRevenue: ['admin', 'analytics', 'revenue'] as const,
  adminReports: ['admin', 'moderation', 'reports'] as const,
  adminTickets: ['admin', 'support', 'tickets'] as const,
  adminSettings: ['admin', 'settings'] as const,
  adminAuditLogs: ['admin', 'settings', 'audit-logs'] as const,
  adminPlans: ['admin', 'premium'] as const,
  adminAccounts: ['admin', 'admin-users'] as const,
  adminSession: ['admin', 'session'] as const,
  // The /api/admin/ops surface (defined in routes/policy.routes.ts, not
  // routes/admin/) plus the admin-only /health/queues probe.
  adminOpsSummary: ['admin', 'ops', 'summary'] as const,
  adminHouseAds: ['admin', 'ops', 'house-ads'] as const,
  adminBlockedDomains: ['admin', 'ops', 'blocked-domains'] as const,
  adminCategoryPolicies: ['admin', 'ops', 'category-policies'] as const,
  adminDeliveryEvents: ['admin', 'ops', 'delivery-events'] as const,
  adminDeliveryTimeline: (id: string) => ['admin', 'ops', 'delivery', id, 'timeline'] as const,
  adminCpcSummary: (advertiserId: string) => ['admin', 'ops', 'cpc', advertiserId] as const,
  adminQueueHealth: ['admin', 'health', 'queues'] as const,
  // Aggregates (spec §7, §39–42) and the subsystem status board.
  adminAnalyticsCampaigns: ['admin', 'analytics', 'campaigns'] as const,
  adminAnalyticsDelivery: ['admin', 'analytics', 'delivery'] as const,
  adminAnalyticsUsers: ['admin', 'analytics', 'users'] as const,
  adminAnalyticsChannels: ['admin', 'analytics', 'channels'] as const,
  adminAnalyticsFunnel: ['admin', 'analytics', 'funnel'] as const,
  adminSystemStatus: ['admin', 'system'] as const,
  // Round 3: computed attention feed and the blocked-entity lists.
  adminAttention: ['admin', 'attention'] as const,
  adminBlockedChannels: ['admin', 'blocked', 'channels'] as const,
  /**
   * Non-deliverable ad posts. Distinct from `adminBlockedAds` above, which is the
   * count of *removed* posts grouped by Telegram error code — a different
   * question answered by a different endpoint.
   */
  adminBlockedAdPosts: ['admin', 'blocked', 'ads'] as const,
  // Round 5: admin ticket thread, admin notification inbox.
  adminTicket: (id: string) => ['admin', 'support', 'tickets', id] as const,
  adminNotifications: ['admin', 'notifications'] as const,
  adminNotificationsUnread: ['admin', 'notifications', 'unread'] as const,
  // Round 4: broadcast audience count and per-entity analytics.
  adminBroadcastAudience: ['admin', 'broadcast', 'audience'] as const,
  // Broadcast delivery report (§52): history, one job, and its recipients.
  adminBroadcastHistory: ['admin', 'broadcast', 'history'] as const,
  adminBroadcastJob: (id: string) => ['admin', 'broadcast', 'job', id] as const,
  adminBroadcastRecipients: (id: string) =>
    ['admin', 'broadcast', 'job', id, 'recipients'] as const,
  adminCampaignAnalytics: (id: string) => ['admin', 'analytics', 'campaign', id] as const,
  adminChannelAnalytics: (id: string) => ['admin', 'analytics', 'channel', id] as const,
};

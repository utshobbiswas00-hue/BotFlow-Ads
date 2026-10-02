/**
 * Typed client for `/api/admin/*`.
 *
 * One function per endpoint, matching `backend/src/routes/admin/*` exactly.
 * The shared `api` instance already injects the Telegram initData header and
 * unwraps the `{ ok, data }` envelope, so nothing here deals with envelopes.
 *
 * Every route below is permission-gated server-side. The panel hides the calls
 * an admin cannot make, but that is a convenience — these functions assume
 * nothing about being allowed, and a 403 surfaces as a normal ApiError.
 */
import { api } from '../../lib/api';
import type { Paginated } from '@botflow/shared';
import type {
  AdminAccount,
  AdminCampaignRow,
  AdminChannelRow,
  AdminDashboard,
  AdminDeliveryRow,
  AdminDepositRow,
  AdminReportRow,
  AdminSession,
  AdminSettingsMap,
  AdminTicket,
  AdminTransactionRow,
  AdminUserDetail,
  AdminUserRow,
  AdminWithdrawalRow,
  AdjustBalanceResult,
  AttentionFeed,
  AuditLogsQuery,
  AuditLogsResult,
  BlockedAdRow,
  BlockedChannelRow,
  AdminNotificationsQuery,
  AdminNotificationsResult,
  AdminTicketThread,
  BlockedAdsSummary,
  BroadcastAudience,
  BroadcastAudienceCount,
  BroadcastJobReport,
  BroadcastJobSummary,
  BroadcastRecipientRow,
  BroadcastRecipientStatus,
  BroadcastResult,
  CampaignAnalytics,
  CampaignAnalyticsDetail,
  ChannelAnalytics,
  ChannelAnalyticsDetail,
  BlockedDomainRow,
  CategoryPolicyValue,
  CategoryPolicyView,
  CpcBillingSummary,
  CryptoAddressView,
  CryptoScanSummary,
  CryptoTransfer,
  DeliveryAnalytics,
  DeliveryEventRow,
  DeliveryTimelineEntry,
  ListQueryParams,
  FunnelAnalytics,
  GlobalSearchResponse,
  HouseAdRow,
  OpsSummary,
  QueueHealthRow,
  QueueStats,
  RefundResult,
  RevenueDay,
  SubsystemHealth,
  SubscriptionPlan,
  UserGrowthAnalytics,
} from './types';

const BASE = '/api/admin';

export interface PageParams {
  page?: number;
  limit?: number;
}

/* ---------- Session ---------- */

export const getSession = (): Promise<AdminSession> => api.get<AdminSession>(`${BASE}/session`);

/* ---------- Panel login (username + password) ---------- */

/**
 * Whether this deployment offers the password door at all. Read by the login
 * screen so it can explain an unconfigured server instead of showing a form that
 * cannot succeed. No secret is involved.
 */
export const getAuthConfig = (): Promise<{ passwordLoginEnabled: boolean }> =>
  api.get<{ passwordLoginEnabled: boolean }>(`${BASE}/auth/config`);

export interface AdminLoginResponse {
  /**
   * The CSRF value to echo in `x-csrf-token`. The session itself is an HttpOnly
   * cookie the server set on this response — nothing here holds the credential.
   */
  csrf: string;
  expiresAt: string;
  admin: {
    id: string;
    role: string;
    isActive: boolean;
    isSuperAdmin: boolean;
    permissions: string[];
    lastLoginAt: string | null;
  };
  user: { id: string; telegramId: string; name: string };
}

/**
 * Exchange username + password for a session.
 *
 * The request must carry `x-csrf-token` matching the pre-session cookie that
 * `getAuthConfig` seeded — that is what stops a cross-site page from signing a
 * victim into an account the attacker controls. The axios interceptor supplies
 * it automatically, as long as `getAuthConfig` ran first.
 */
export const loginWithPassword = (
  username: string,
  password: string,
): Promise<AdminLoginResponse> =>
  api.post<AdminLoginResponse>(`${BASE}/auth/login`, { username, password });

/** Destroys the server-side session and clears both cookies. */
export const logoutAdmin = (): Promise<{ loggedOut: boolean }> =>
  api.post<{ loggedOut: boolean }>(`${BASE}/auth/logout`, {});

export interface AdminAuthMeResponse {
  admin: { id: string; role: string; isSuperAdmin: boolean; permissions: string[] };
  csrf: string | null;
  sessionActive: boolean;
}

/** Identity + CSRF for the current request; used to revalidate on a cold load. */
export const getAuthMe = (): Promise<AdminAuthMeResponse> => api.get(`${BASE}/auth/me`);

export interface AdminSessionSummary {
  /** Last 12 characters of the hashed store key — enough to tell sessions apart. */
  fingerprint: string;
  createdAt: string;
  ip: string;
  userAgent: string;
}

/** Live sessions for the acting admin, newest first. */
export const listAdminSessions = (): Promise<{ sessions: AdminSessionSummary[] }> =>
  api.get(`${BASE}/auth/sessions`);

/** Sign out everywhere, including this browser. */
export const revokeAllAdminSessions = (): Promise<{ revoked: number }> =>
  api.post<{ revoked: number }>(`${BASE}/auth/sessions/revoke-all`, {});

/* ---------- Dashboard ---------- */

export const getDashboard = (): Promise<AdminDashboard> => api.get<AdminDashboard>(`${BASE}/dashboard`);

export const getQueueStats = (): Promise<QueueStats> => api.get<QueueStats>(`${BASE}/dashboard/queues`);

/* ---------- Campaigns ---------- */

export interface CampaignsQuery extends ListQueryParams {
  status?: string;
}

export const listCampaigns = (q: CampaignsQuery = {}): Promise<Paginated<AdminCampaignRow>> =>
  api.get<Paginated<AdminCampaignRow>>(`${BASE}/campaigns`, {
    page: q.page,
    limit: q.limit,
    from: q.from || undefined,
    to: q.to || undefined,
    sort: q.sort || undefined,
    status: q.status || undefined,
  });

export type CampaignAction = 'APPROVE' | 'REJECT' | 'PAUSE' | 'RESUME' | 'CANCEL' | 'SUSPEND';

export interface CampaignActionResult {
  campaignId: string;
  action: CampaignAction;
  status: string;
  enqueued?: number;
  cancelledJobs?: number;
}

export const campaignAction = (
  campaignId: string,
  action: CampaignAction,
  note?: string,
): Promise<CampaignActionResult> =>
  api.post<CampaignActionResult>(`${BASE}/campaigns/action`, {
    campaignId,
    action,
    note: note?.trim() ? note.trim() : null,
  });

/* ---------- Channels ---------- */

export interface ChannelsQuery extends ListQueryParams {
  status?: string;
}

export const listChannels = (q: ChannelsQuery = {}): Promise<Paginated<AdminChannelRow>> =>
  api.get<Paginated<AdminChannelRow>>(`${BASE}/channels`, {
    page: q.page,
    limit: q.limit,
    from: q.from || undefined,
    to: q.to || undefined,
    sort: q.sort || undefined,
    status: q.status || undefined,
  });

export type ChannelAction = 'APPROVE' | 'REJECT' | 'SUSPEND' | 'REACTIVATE';

export interface ChannelActionResult {
  channelId: string;
  action: ChannelAction;
  status: string;
  cancelledJobs?: number;
}

export const channelAction = (
  channelId: string,
  action: ChannelAction,
  note?: string,
): Promise<ChannelActionResult> =>
  api.post<ChannelActionResult>(`${BASE}/channels/action`, {
    channelId,
    action,
    note: note?.trim() ? note.trim() : null,
  });

export const getBlockedAds = (): Promise<BlockedAdsSummary> =>
  api.get<BlockedAdsSummary>(`${BASE}/channels/blocked`);

/* ---------- Users ---------- */

export interface UsersQuery extends ListQueryParams {
  search?: string;
  /** Account status filter: ACTIVE | SUSPENDED | BANNED | PENDING. */
  status?: string;
  /**
   * Role filters. These are derived server-side from the relationships
   * (a publisher has at least one channel, an advertiser at least one campaign),
   * not from the cached boolean columns, so they cannot go stale.
   */
  isPublisher?: boolean;
  isAdvertiser?: boolean;
}

export const listUsers = (q: UsersQuery = {}): Promise<Paginated<AdminUserRow>> =>
  api.get<Paginated<AdminUserRow>>(`${BASE}/users`, {
    page: q.page,
    limit: q.limit,
    from: q.from || undefined,
    to: q.to || undefined,
    sort: q.sort || undefined,
    search: q.search?.trim() || undefined,
    status: q.status || undefined,
    isPublisher: q.isPublisher,
    isAdvertiser: q.isAdvertiser,
  });

export const getUser = (id: string): Promise<AdminUserDetail> =>
  api.get<AdminUserDetail>(`${BASE}/users/${encodeURIComponent(id)}`);

export const adjustBalance = (
  userId: string,
  amountCents: number,
  reason: string,
): Promise<AdjustBalanceResult> =>
  api.post<AdjustBalanceResult>(`${BASE}/users/adjust-balance`, { userId, amountCents, reason });

/* ---------- Delivery ---------- */

export interface DeliveryQuery extends ListQueryParams {
  status?: string;
}

export const listDelivery = (q: DeliveryQuery = {}): Promise<Paginated<AdminDeliveryRow>> =>
  api.get<Paginated<AdminDeliveryRow>>(`${BASE}/delivery`, {
    page: q.page,
    limit: q.limit,
    from: q.from || undefined,
    to: q.to || undefined,
    sort: q.sort || undefined,
    status: q.status || undefined,
  });

export const getDeliveryStats = (): Promise<QueueStats> => api.get<QueueStats>(`${BASE}/delivery/stats`);

export const retryDelivery = (id: string): Promise<{ id: string; retried: boolean }> =>
  api.post<{ id: string; retried: boolean }>(`${BASE}/delivery/${encodeURIComponent(id)}/retry`);

/* ---------- Finance ---------- */

export interface DepositsQuery extends ListQueryParams {
  status?: string;
}

export const listDeposits = (q: DepositsQuery = {}): Promise<Paginated<AdminDepositRow>> =>
  api.get<Paginated<AdminDepositRow>>(`${BASE}/finance/deposits`, {
    page: q.page,
    limit: q.limit,
    from: q.from || undefined,
    to: q.to || undefined,
    sort: q.sort || undefined,
    status: q.status || undefined,
  });

export const depositAction = (
  depositId: string,
  action: 'VERIFY' | 'REJECT',
  note?: string,
): Promise<unknown> =>
  api.post(`${BASE}/finance/deposits/action`, {
    depositId,
    action,
    note: note?.trim() ? note.trim() : null,
  });

export interface WithdrawalsQuery extends ListQueryParams {
  status?: string;
}

export const listWithdrawals = (q: WithdrawalsQuery = {}): Promise<Paginated<AdminWithdrawalRow>> =>
  api.get<Paginated<AdminWithdrawalRow>>(`${BASE}/finance/withdrawals`, {
    page: q.page,
    limit: q.limit,
    from: q.from || undefined,
    to: q.to || undefined,
    sort: q.sort || undefined,
    status: q.status || undefined,
  });

export const withdrawalAction = (
  withdrawalId: string,
  action: 'APPROVE' | 'REJECT' | 'MARK_PAID',
  opts: { note?: string; txRef?: string } = {},
): Promise<unknown> =>
  api.post(`${BASE}/finance/withdrawals/action`, {
    withdrawalId,
    action,
    note: opts.note?.trim() ? opts.note.trim() : null,
    txRef: opts.txRef?.trim() ? opts.txRef.trim() : null,
  });

export interface TransactionsQuery extends ListQueryParams {
  type?: string;
  userId?: string;
}

export const listTransactions = (q: TransactionsQuery = {}): Promise<Paginated<AdminTransactionRow>> =>
  api.get<Paginated<AdminTransactionRow>>(`${BASE}/finance/transactions`, {
    page: q.page,
    limit: q.limit,
    from: q.from || undefined,
    to: q.to || undefined,
    sort: q.sort || undefined,
    type: q.type || undefined,
    userId: q.userId?.trim() || undefined,
  });

/* ---------- Analytics ---------- */

export const getRevenue = (days: number): Promise<{ byDay: RevenueDay[] }> =>
  api.get<{ byDay: RevenueDay[] }>(`${BASE}/analytics/revenue`, { days });

/* ---------- Moderation ---------- */

export interface ReportsQuery extends PageParams {
  status?: string;
}

export const listReports = (q: ReportsQuery = {}): Promise<Paginated<AdminReportRow>> =>
  api.get<Paginated<AdminReportRow>>(`${BASE}/moderation/reports`, {
    page: q.page,
    limit: q.limit,
    status: q.status || undefined,
  });

export const reportAction = (
  reportId: string,
  action: 'RESOLVE' | 'DISMISS',
  actionTaken?: string,
): Promise<unknown> =>
  api.post(`${BASE}/moderation/reports/action`, {
    reportId,
    action,
    actionTaken: actionTaken?.trim() ? actionTaken.trim() : null,
  });

export const adPostAction = (adPostId: string, action: 'REMOVE' | 'APPROVE'): Promise<unknown> =>
  api.post(`${BASE}/moderation/ads/action`, { adPostId, action });

export const runFraudScan = (): Promise<{ events: number }> =>
  api.post<{ events: number }>(`${BASE}/moderation/scan`);

export const recalculateRisk = (userId: string): Promise<{ score: number }> =>
  api.post<{ score: number }>(`${BASE}/moderation/users/${encodeURIComponent(userId)}/risk`);

/* ---------- Support ---------- */

export interface TicketsQuery extends PageParams {
  status?: string;
}

export const listTickets = (q: TicketsQuery = {}): Promise<Paginated<AdminTicket>> =>
  api.get<Paginated<AdminTicket>>(`${BASE}/support/tickets`, {
    page: q.page,
    limit: q.limit,
    status: q.status || undefined,
  });

export const replyTicket = (id: string, body: string): Promise<AdminTicket> =>
  api.post<AdminTicket>(`${BASE}/support/tickets/${encodeURIComponent(id)}/reply`, { body });

export const setTicketStatus = (id: string, status: string): Promise<AdminTicket> =>
  api.post<AdminTicket>(`${BASE}/support/tickets/${encodeURIComponent(id)}/status`, { status });

/**
 * Read a ticket's message thread as an admin.
 *
 * This is the endpoint that was missing. The only thread read in the API is
 * owner-scoped, so it returned 404 to staff. Same ticket, same messages, no
 * ownership assertion — the authorisation is the route's `tickets.view` permission.
 */
export const getTicketThread = (id: string): Promise<AdminTicketThread> =>
  api.get<AdminTicketThread>(`${BASE}/support/tickets/${encodeURIComponent(id)}`);

/* ---------- Admin notification inbox ---------- */

/**
 * The acting admin's own notifications, paginated, newest first.
 *
 * `unread` accompanies the page so the inbox and the nav badge cannot disagree
 * after a mark-as-read.
 */
export const listAdminNotifications = (
  q: AdminNotificationsQuery = {},
): Promise<AdminNotificationsResult> =>
  api.get<AdminNotificationsResult>(`${BASE}/notifications`, {
    page: q.page,
    limit: q.limit,
    unreadOnly: q.unreadOnly ? 'true' : undefined,
  });

export const getAdminUnreadCount = (): Promise<{ unread: number }> =>
  api.get<{ unread: number }>(`${BASE}/notifications/unread-count`);

/** Marks one notification read. Idempotent — an already-read row is a no-op. */
export const markAdminNotificationRead = (id: string): Promise<{ id: string; isRead: boolean }> =>
  api.post<{ id: string; isRead: boolean }>(`${BASE}/notifications/${encodeURIComponent(id)}/read`);

export const markAllAdminNotificationsRead = (): Promise<{ updated: number }> =>
  api.post<{ updated: number }>(`${BASE}/notifications/read-all`);

/* ---------- Settings ---------- */

export const getSettings = (): Promise<AdminSettingsMap> => api.get<AdminSettingsMap>(`${BASE}/settings`);

export const saveSetting = (key: string, value: unknown): Promise<{ updated: boolean }> =>
  api.post<{ updated: boolean }>(`${BASE}/settings`, { key, value });

export const getAuditLogs = (q: AuditLogsQuery = {}): Promise<AuditLogsResult> =>
  api.get<AuditLogsResult>(`${BASE}/settings/audit-logs`, {
    actorId: q.actorId?.trim() || undefined,
    action: q.action?.trim() || undefined,
    targetType: q.targetType?.trim() || undefined,
    from: q.from?.trim() || undefined,
    to: q.to?.trim() || undefined,
    skip: q.skip,
    take: q.take,
  });

/* ---------- Premium plans ---------- */

export const listPlans = (): Promise<SubscriptionPlan[]> => api.get<SubscriptionPlan[]>(`${BASE}/premium`);

export const getPlan = (code: string): Promise<SubscriptionPlan> =>
  api.get<SubscriptionPlan>(`${BASE}/premium/${encodeURIComponent(code)}`);

export interface PlanInput {
  code: string;
  name: string;
  description?: string;
  tier?: 'FREE' | 'PREMIUM' | 'BUSINESS';
  period?: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  priceCents: number;
  durationDays?: number;
  benefits?: Record<string, number | boolean>;
  sortOrder?: number;
  isFeatured?: boolean;
  badgeText?: string;
}

export const upsertPlan = (input: PlanInput): Promise<{ id: string; code: string }> =>
  api.post<{ id: string; code: string }>(`${BASE}/premium`, input);

export const setPlanActive = (
  code: string,
  isActive: boolean,
): Promise<{ code: string; isActive: boolean }> =>
  api.patch<{ code: string; isActive: boolean }>(`${BASE}/premium/${encodeURIComponent(code)}/active`, {
    isActive,
  });

/* ---------- Crypto deposit addresses ---------- */

export const listCryptoAddresses = (): Promise<CryptoAddressView[]> =>
  api.get<CryptoAddressView[]>(`${BASE}/crypto-addresses`);

export const saveCryptoAddress = (
  network: string,
  body: { address: string; memo?: string | null; label?: string | null; isActive?: boolean },
): Promise<CryptoAddressView> =>
  api.put<CryptoAddressView>(`${BASE}/crypto-addresses/${encodeURIComponent(network)}`, body);

export const setCryptoAddressActive = (network: string, isActive: boolean): Promise<CryptoAddressView> =>
  api.patch<CryptoAddressView>(`${BASE}/crypto-addresses/${encodeURIComponent(network)}/active`, {
    isActive,
  });

export const deleteCryptoAddress = (network: string): Promise<{ deleted: boolean; network: string }> =>
  api.delete<{ deleted: boolean; network: string }>(
    `${BASE}/crypto-addresses/${encodeURIComponent(network)}`,
  );

/* ---------- Crypto transfers ---------- */

export const listCryptoTransfers = (): Promise<CryptoTransfer[]> =>
  api.get<CryptoTransfer[]>(`${BASE}/crypto-transfers`);

export const getScannableNetworks = (): Promise<{ networks: string[] }> =>
  api.get<{ networks: string[] }>(`${BASE}/crypto-transfers/scannable`);

export interface RecordTransferInput {
  network: string;
  txHash: string;
  asset: string;
  fromAddress: string;
  toAddress: string;
  amountRaw: string;
  decimals?: number | null;
  symbol?: string | null;
  blockNumber?: number | null;
}

export const recordCryptoTransfer = (input: RecordTransferInput): Promise<unknown> =>
  api.post(`${BASE}/crypto-transfers`, {
    ...input,
    decimals: input.decimals ?? null,
    symbol: input.symbol ?? null,
    blockNumber: input.blockNumber ?? null,
  });

export const creditCryptoTransfer = (id: string, userId: string): Promise<unknown> =>
  api.post(`${BASE}/crypto-transfers/${encodeURIComponent(id)}/credit`, { userId });

export const ignoreCryptoTransfer = (id: string, reason: string): Promise<unknown> =>
  api.post(`${BASE}/crypto-transfers/${encodeURIComponent(id)}/ignore`, { reason });

export const runCryptoScan = (): Promise<CryptoScanSummary> =>
  api.post<CryptoScanSummary>(`${BASE}/crypto-transfers/scan`);

/* ---------- Admin accounts (SUPER_ADMIN only) ---------- */

export const listAdminAccounts = (q: PageParams = {}): Promise<Paginated<AdminAccount>> =>
  api.get<Paginated<AdminAccount>>(`${BASE}/admin-users`, { page: q.page, limit: q.limit });

export const createAdminAccount = (telegramId: string, role: string): Promise<AdminAccount> =>
  api.post<AdminAccount>(`${BASE}/admin-users`, { telegramId, role });

export const updateAdminAccount = (
  id: string,
  patch: { role?: string; isActive?: boolean },
): Promise<AdminAccount> => api.patch<AdminAccount>(`${BASE}/admin-users/${encodeURIComponent(id)}`, patch);

export const deactivateAdminAccount = (id: string): Promise<AdminAccount> =>
  api.delete<AdminAccount>(`${BASE}/admin-users/${encodeURIComponent(id)}`);

/* ===============================================================
 * The second admin surface: /api/admin/ops/*
 *
 * Defined in `routes/policy.routes.ts` (NOT `routes/admin/`) and mounted on the
 * user-facing router as `/api/admin/ops`. Same guards — `requireAdmin()` at the
 * router level, then a per-route `requirePermission` or `requireRole`.
 *
 * Two of these are role-gated rather than permission-gated:
 * `/cpc/settle` and `/referrals/settle` require
 * `requireRole('ADMIN','SUPER_ADMIN','FINANCE_MANAGER')`, so a MODERATOR with
 * every permission key still cannot call them. The UI checks the session role for
 * those two.
 * =============================================================== */

const OPS = '/api/admin/ops';

export const getOpsSummary = (): Promise<OpsSummary> => api.get<OpsSummary>(`${OPS}/summary`);

/* ---------- House ads (unsold inventory fill) ---------- */

export const getHouseAds = (): Promise<{ ads: HouseAdRow[]; languageRule: string }> =>
  api.get<{ ads: HouseAdRow[]; languageRule: string }>(`${OPS}/house-ads`);

export interface HouseAdInput {
  code?: string;
  title: string;
  body: string;
  imageUrl?: string | null;
  buttonText?: string | null;
  buttonUrl?: string | null;
  links?: { label: string; url: string }[];
  weight?: number;
  isActive?: boolean;
  sortOrder?: number;
  note?: string | null;
}

export const upsertHouseAd = (input: HouseAdInput): Promise<{ id: string }> =>
  api.post<{ id: string }>(`${OPS}/house-ads`, input);

export const setHouseAdActive = (id: string, isActive: boolean): Promise<{ updated: boolean }> =>
  api.post<{ updated: boolean }>(`${OPS}/house-ads/${encodeURIComponent(id)}/active`, { isActive });

/* ---------- Blocked domains ---------- */

export const listBlockedDomains = (q: PageParams = {}): Promise<Paginated<BlockedDomainRow>> =>
  api.get<Paginated<BlockedDomainRow>>(`${OPS}/blocked-domains`, { page: q.page, limit: q.limit });

export const addBlockedDomain = (body: {
  domain: string;
  reason?: string;
  hardBlock?: boolean;
}): Promise<BlockedDomainRow> => api.post<BlockedDomainRow>(`${OPS}/blocked-domains`, body);

export const removeBlockedDomain = (id: string): Promise<{ removed: boolean }> =>
  api.delete<{ removed: boolean }>(`${OPS}/blocked-domains/${encodeURIComponent(id)}`);

/* ---------- Category policies ---------- */

/** Read side is the user-facing route; it needs no special permission. */
export const getCategoryPolicies = (): Promise<CategoryPolicyView[]> =>
  api.get<CategoryPolicyView[]>('/api/categories/policies');

export const setCategoryPolicy = (body: {
  category: string;
  policy: CategoryPolicyValue;
  note?: string;
}): Promise<CategoryPolicyView> =>
  api.post<CategoryPolicyView>(`${OPS}/categories/policies`, body);

/* ---------- Ad creative review ---------- */

export const reviewCreativeVersion = (
  versionId: string,
  action: 'APPROVE' | 'REJECT',
  note?: string,
): Promise<{ reviewed: boolean }> =>
  api.post<{ reviewed: boolean }>(
    `${OPS}/creative-versions/${encodeURIComponent(versionId)}/review`,
    { action, note: note?.trim() ? note.trim() : undefined },
  );

/* ---------- Delivery operations ---------- */

export const refreshAllChannelHealth = (): Promise<{ changed: number }> =>
  api.post<{ changed: number }>(`${OPS}/health/refresh-all`);

export const getDeliveryTimeline = (deliveryJobId: string): Promise<DeliveryTimelineEntry[]> =>
  api.get<DeliveryTimelineEntry[]>(
    `${OPS}/delivery/${encodeURIComponent(deliveryJobId)}/timeline`,
  );

export const getRecentDeliveryEvents = (): Promise<DeliveryEventRow[]> =>
  api.get<DeliveryEventRow[]>(`${OPS}/delivery/events/recent`);

/* ---------- CPC settlement ---------- */

export const settleCpc = (): Promise<{ settled: number }> =>
  api.post<{ settled: number }>(`${OPS}/cpc/settle`);

export const getCpcSummary = (advertiserId: string): Promise<CpcBillingSummary> =>
  api.get<CpcBillingSummary>(`${OPS}/cpc/summary/${encodeURIComponent(advertiserId)}`);

/* ---------- Referral settlement ---------- */

export const settleReferrals = (): Promise<{ rewarded: number }> =>
  api.post<{ rewarded: number }>(`${OPS}/referrals/settle`);

/* ---------- Infrastructure ---------- */

/**
 * Live BullMQ counts. Mounted on the app root, NOT under /api
 * (`app.use('/health', healthRouter)`), but it is still admin-gated with
 * `telegramAuth` + `requireAdmin`.
 */
export const getQueueHealth = (): Promise<QueueHealthRow[]> =>
  api.get<QueueHealthRow[]>('/health/queues');

/* ---------- Aggregates (spec §7, §39–42) ---------- */

/**
 * Campaign counts by status plus budget totals. Computed server-side with
 * `groupBy`, so this is a handful of rows rather than one per campaign.
 */
export const getCampaignAnalytics = (): Promise<CampaignAnalytics> =>
  api.get<CampaignAnalytics>(`${BASE}/analytics/campaigns`);

/** Delivery-job counts by status for a window, plus mean attempts. */
export const getDeliveryAnalytics = (days: number): Promise<DeliveryAnalytics> =>
  api.get<DeliveryAnalytics>(`${BASE}/analytics/delivery`, { days });

/** New users / publishers / advertisers per UTC day. */
export const getUserGrowth = (days: number): Promise<UserGrowthAnalytics> =>
  api.get<UserGrowthAnalytics>(`${BASE}/analytics/users`, { days });

export const getChannelAnalytics = (): Promise<ChannelAnalytics> =>
  api.get<ChannelAnalytics>(`${BASE}/analytics/channels`);

/** The spec §86 product loop as lifetime counts. */
export const getFunnel = (): Promise<FunnelAnalytics> => api.get<FunnelAnalytics>(`${BASE}/analytics/funnel`);

/* ---------- System status (§27, §28, §83) ---------- */

/**
 * Subsystem health board. The server catches every probe individually, so a dead
 * dependency arrives as one UNKNOWN/DEGRADED entry rather than as a failed call.
 */
export const getSystemStatus = (): Promise<SubsystemHealth[]> =>
  api.get<SubsystemHealth[]>(`${BASE}/system`);

/* ---------- Refunds (§38) ---------- */

/**
 * Issue an admin refund against a campaign, crediting the advertiser's balance.
 *
 * Goes through the ledger like every other money movement: a REFUND transaction
 * with its own reference, so it can never be applied twice and so it appears in
 * the ledger and the audit log rather than only in this panel.
 *
 * The reason is required — an unexplained credit is indistinguishable from a
 * mistake when someone reviews the ledger months later.
 */
export const createRefund = (body: {
  campaignId: string;
  amountCents: number;
  reason: string;
}): Promise<RefundResult> => api.post<RefundResult>(`${BASE}/finance/refunds`, body);

/* ---------- Broadcast (§52) ---------- */

/**
 * How many users a broadcast would reach. Call this before sending: the composer
 * shows the number so "ALL" is a decision, not a guess.
 */
export const getBroadcastAudience = (audience: BroadcastAudience): Promise<BroadcastAudienceCount> =>
  api.get<BroadcastAudienceCount>(`${BASE}/broadcast/audience`, { audience });

/**
 * Queue a broadcast. `dryRun: true` validates and counts without enqueueing
 * anything, which is what the confirmation step uses.
 */
export const sendBroadcast = (body: {
  title: string;
  body: string;
  audience: BroadcastAudience;
  dryRun?: boolean;
}): Promise<BroadcastResult> => api.post<BroadcastResult>(`${BASE}/broadcast`, body);

/**
 * Broadcast delivery report — the durable history the composer never had.
 * `sendBroadcast` returns the new job's id, which is the id these read by.
 */

/** Paginated broadcast history, newest first. */
export const listBroadcastHistory = (q: PageParams = {}): Promise<Paginated<BroadcastJobSummary>> =>
  api.get<Paginated<BroadcastJobSummary>>(`${BASE}/broadcast/history`, {
    page: q.page,
    limit: q.limit,
  });

/**
 * One broadcast with its live per-status counts. The server returns the job's
 * denormalised counters AND a `groupBy` over the recipients, so a drift between
 * the two is visible rather than hidden.
 */
export const getBroadcastJob = (id: string): Promise<BroadcastJobReport> =>
  api.get<BroadcastJobReport>(`${BASE}/broadcast/${encodeURIComponent(id)}`);

/** One job's recipients, paginated, with an optional status filter. */
export const listBroadcastRecipients = (
  id: string,
  q: PageParams & { status?: BroadcastRecipientStatus | '' } = {},
): Promise<Paginated<BroadcastRecipientRow>> =>
  api.get<Paginated<BroadcastRecipientRow>>(
    `${BASE}/broadcast/${encodeURIComponent(id)}/recipients`,
    {
      page: q.page,
      limit: q.limit,
      status: q.status || undefined,
    },
  );

/* ---------- Per-entity analytics (§40, §41) ---------- */

export const getCampaignAnalyticsDetail = (campaignId: string): Promise<CampaignAnalyticsDetail> =>
  api.get<CampaignAnalyticsDetail>(`${BASE}/analytics/campaigns/${encodeURIComponent(campaignId)}`);

export const getChannelAnalyticsDetail = (channelId: string): Promise<ChannelAnalyticsDetail> =>
  api.get<ChannelAnalyticsDetail>(`${BASE}/analytics/channels/${encodeURIComponent(channelId)}`);

/* ---------- Cross-entity search (§64) ---------- */

/**
 * Search users, channels, campaigns, transactions and tickets in one call.
 *
 * The server caps each entity at `limit` and runs them in parallel, so a slow or
 * failing entity cannot fail the whole search. `q` must be at least 2 characters —
 * the server rejects shorter, which is also why the UI does not call this until
 * the operator has typed something meaningful.
 */
export const getGlobalSearch = (q: string, limit = 5): Promise<GlobalSearchResponse> =>
  api.get<GlobalSearchResponse>(`${BASE}/search`, { q: q.trim(), limit });

/* ---------- Attention feed (§52, §65) ---------- */

/**
 * What needs an operator right now. Computed on read from eleven counts, so it is
 * a view rather than an inbox — nothing is stored and nothing is marked read.
 */
export const getAttentionFeed = (): Promise<AttentionFeed> =>
  api.get<AttentionFeed>(`${BASE}/attention`);

/* ---------- Blocked channels / ad posts (§46–48) ---------- */

export interface BlockedChannelsQuery extends PageParams {
  search?: string;
}

export const listBlockedChannels = (
  q: BlockedChannelsQuery = {},
): Promise<Paginated<BlockedChannelRow>> =>
  api.get<Paginated<BlockedChannelRow>>(`${BASE}/blocked/channels`, {
    page: q.page,
    limit: q.limit,
    search: q.search?.trim() || undefined,
  });

/**
 * Add a channel block.
 *
 * The body shape follows the real model: `PublisherBlocklist` is keyed on
 * (channelId, scope, value) and has `label`, not `reason`. The API maps the
 * free-text `reason` into `label`.
 */
export const blockChannel = (body: {
  channelId: string;
  scope: BlockedChannelRow['scope'];
  value: string;
  reason: string;
}): Promise<BlockedChannelRow> => api.post<BlockedChannelRow>(`${BASE}/blocked/channels`, body);

export const unblockChannel = (id: string): Promise<{ id: string; deleted: boolean }> =>
  api.delete<{ id: string; deleted: boolean }>(`${BASE}/blocked/channels/${encodeURIComponent(id)}`);

export interface BlockedAdsQuery extends PageParams {}

export const listBlockedAds = (q: BlockedAdsQuery = {}): Promise<Paginated<BlockedAdRow>> =>
  api.get<Paginated<BlockedAdRow>>(`${BASE}/blocked/ads`, { page: q.page, limit: q.limit });

/**
 * Block an ad post.
 *
 * Reality: there is no ad-block column. The server sets the post to
 * `AdPostStatus.DELETED`, stamps `BLOCKED_BY_ADMIN:<reason>` into `errorMessage`,
 * and writes an `AD_POST_BLOCKED` audit row — the audit row is the authoritative
 * record, and unblocking restores the previous status from it.
 */
export const blockAdPost = (id: string, reason: string): Promise<{ id: string; status: string }> =>
  api.post<{ id: string; status: string }>(`${BASE}/blocked/ads/${encodeURIComponent(id)}/block`, {
    reason,
  });

/** Lift an admin block. Refuses to reverse a genuine moderation removal. */
export const unblockAdPost = (id: string): Promise<{ id: string; status: string }> =>
  api.delete<{ id: string; status: string }>(
    `${BASE}/blocked/ads/${encodeURIComponent(id)}/block`,
  );

/**
 * Admin panel response types.
 *
 * Every shape here mirrors a real backend response 1:1 — nothing is invented.
 * Where a shape already exists in `lib/contracts.ts` it is re-exported from
 * there rather than re-declared, so the two can never drift apart.
 *
 * Two conventions inherited from `routes/admin/common.ts` (`jsonSafe`):
 *  - every Prisma BigInt arrives as a DECIMAL STRING (telegramId, blockNumber…)
 *  - every Date arrives as an ISO-8601 string
 * Money is always integer cents.
 */
import type { Paginated } from '@botflow/shared';

export type {
  AdminDashboard,
  AdminCampaignRow,
  AdminChannelRow,
  AdminUserRow,
  AdminDeliveryRow,
  AdminDepositRow,
  AdminWithdrawalRow,
  AdminReportRow,
  RevenueSeries,
} from '../../lib/contracts';

export type { Paginated, CampaignSummary, ChannelSummary } from '@botflow/shared';

/* ---------- Session ---------- */

export interface AdminSession {
  /**
   * How this request authenticated. `active: true` means a cookie session exists,
   * which is what makes a sign-out control meaningful; `csrf` is the value the
   * client must echo on unsafe methods (null on the Telegram path).
   */
  session: {
    active: boolean;
    csrf: string | null;
  };
  admin: {
    id: string;
    role: string;
    isActive: boolean;
    isSuperAdmin: boolean;
    permissions: string[];
    lastLoginAt: string | null;
    createdAt: string;
  };
  user: {
    id: string;
    telegramId: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    photoUrl: string | null;
    status: string;
    name: string;
  };
}

/* ---------- Dashboard / queues ---------- */

export interface QueueStats {
  total: number;
  published: number;
  pending: number;
  failed: number;
  awaitingApproval: number;
  cancelled: number;
}

/* ---------- Channels ---------- */

export interface BlockedAdsSummary {
  total: number;
  byErrorCode: Record<string, number>;
}

/* ---------- Users ---------- */

export interface UserEarningsSummary {
  totalPosts: number;
  totalGrossCents: number;
  totalNetCents: number;
  pendingCents: number;
  availableCents: number;
  paidCents: number;
}

export interface AdminUserDetailTransaction {
  id: string;
  type: string;
  status: string;
  amountCents: number;
  currency: string;
  reference: string;
  referenceType: string | null;
  description: string | null;
  createdAt: string;
}

export interface AdminUserDetailDeposit {
  id: string;
  amountCents: number;
  currency: string;
  method: string;
  status: string;
  createdAt: string;
  verifiedAt: string | null;
}

export interface AdminUserDetailWithdrawal {
  id: string;
  amountCents: number;
  feeCents: number;
  netAmountCents: number;
  currency: string;
  method: string;
  status: string;
  createdAt: string;
  processedAt: string | null;
}

export interface AdminUserDetail {
  profile: import('../../lib/contracts').AdminUserRow;
  channels: import('@botflow/shared').ChannelSummary[];
  campaigns: import('@botflow/shared').CampaignSummary[];
  transactions: AdminUserDetailTransaction[];
  deposits: AdminUserDetailDeposit[];
  withdrawals: AdminUserDetailWithdrawal[];
  earnings: UserEarningsSummary;
}

export interface AdjustBalanceResult {
  transactionId: string;
  reference: string;
  previousBalanceCents: number;
  newBalanceCents: number;
}

/* ---------- Finance ---------- */

export interface AdminTransactionRow {
  id: string;
  userId: string;
  type: string;
  status: string;
  amountCents: number;
  currency: string;
  balanceAfter: number;
  reference: string;
  referenceType: string | null;
  description: string | null;
  createdAt: string;
  userName: string;
}

export interface RevenueDay {
  /** UTC calendar day, "YYYY-MM-DD". */
  date: string;
  revenueCents: number;
}

/* ---------- Support ---------- */

export interface AdminTicket {
  id: string;
  ticketNo: string;
  subject: string;
  category: string;
  status: string;
  priority: string;
  assignedToId: string | null;
  lastMessageAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    telegramId: string;
  };
  userName: string;
}

/* ---------- Settings & audit ---------- */

export type AdminSettingsMap = Record<string, unknown>;

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorType: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  oldValue: unknown;
  newValue: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  actor: {
    id: string;
    username: string | null;
    firstName: string | null;
    telegramId: string;
  } | null;
}

/** Note: audit logs use `{ total, items }` — NOT the 5-key paginated envelope. */
export interface AuditLogsResult {
  total: number;
  items: AuditLogEntry[];
}

export interface AuditLogsQuery {
  actorId?: string;
  action?: string;
  targetType?: string;
  from?: string;
  to?: string;
  skip?: number;
  take?: number;
}

/* ---------- Premium plans ---------- */

export interface SubscriptionPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  tier: string;
  period: string;
  priceCents: number;
  currency: string;
  durationDays: number;
  benefits: Record<string, number | boolean> | null;
  sortOrder: number;
  isActive: boolean;
  isFeatured: boolean;
  badgeText: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The keys `upsertPlan` honours in a plan's `benefits` object. */
export const ENTITLEMENT_KEYS = [
  'maxChannels',
  'maxActiveCampaigns',
  'platformFeePercent',
  'publisherEarningBonusPct',
  'dailyWithdrawLimitCents',
  'monthlyWithdrawLimitCents',
  'minWithdrawalCents',
  'maxCampaignBudgetCents',
  'channelCooldownHours',
  'maxCampaignsPerHour',
  'advancedAnalytics',
  'prioritySupport',
  'featuredMarketplace',
  'autoApproveCampaigns',
  'referralBonusPercent',
] as const;

export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

/* ---------- Crypto ---------- */

export interface CryptoAddressView {
  network: string;
  asset: string;
  chain: string;
  configured: boolean;
  address: string | null;
  memo: string | null;
  label: string | null;
  isActive: boolean;
}

export interface CryptoTransfer {
  id: string;
  network: string;
  txHash: string;
  asset: string;
  fromAddress: string;
  toAddress: string;
  /** Integer amount in the asset's smallest unit, as a string. */
  amountRaw: string;
  priceUsdCents: number | null;
  amountCents: number | null;
  blockNumber: string | null;
  confirmations: number;
  status: 'DETECTED' | 'CREDITED' | 'IGNORED';
  depositId: string | null;
  note: string | null;
  observedAt: string;
  creditedAt: string | null;
}

export interface CryptoScanSummary {
  scanned: number;
  recorded: number;
  skipped: number;
}

/* ---------- Admin accounts ---------- */

export interface AdminAccount {
  id: string;
  role: string;
  permissions: unknown;
  isActive: boolean;
  createdById: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  userId: string;
  userName: string;
  username: string | null;
  telegramId: string;
}

/* ---------------------------------------------------------------
 * The SECOND admin surface: /api/admin/ops/*
 *
 * These routes live in `routes/policy.routes.ts`, not `routes/admin/`, and are
 * mounted as `/api/admin/ops` on the user-facing router. Unlike the other admin
 * router they do NOT pass through `jsonSafe`/`respondOk` — every handler calls
 * `res.json({ ok: true, data: <service result> })` directly. The shared axios
 * interceptor still unwraps that envelope, and none of these functions projects
 * a BigInt column, so the shapes below are the raw values.
 * ------------------------------------------------------------- */

export interface HouseFillStats {
  housePostsToday: number;
  housePostsTotal: number;
  activeCreatives: number;
}

export interface HouseAdStats {
  activeCreatives: number;
  housePostsPublished: number;
}

export interface ReferralQueueStats {
  pending: number;
  rewarded: number;
  rejected: number;
  pendingRewardsCents: number;
}

/** One creative version waiting on admin review (`pendingReviewVersions()`). */
export interface PendingCreativeItem {
  id: string;
  adId: string;
  version: number;
  status: string;
  /** TEXT | IMAGE | IMAGE_TEXT | BUTTON */
  format: string;
  text: string;
  imageUrl: string | null;
  buttonText: string | null;
  buttonUrl: string | null;
  destinationUrl: string | null;
  changeNote: string | null;
  createdAt: string;
  ad: {
    id: string;
    trackingSlug: string;
    campaign: {
      id: string;
      name: string;
      advertiser: { id: string; name: string };
    };
  };
}

/** `GET /api/admin/ops/summary` — an aggregate, not a filtered list. */
export interface OpsSummary {
  delivery: QueueStats;
  house: HouseFillStats;
  houseAds: HouseAdStats;
  /** Only the event types that actually occurred in the last 24h. */
  deliveryEvents: Record<string, number>;
  creativeQueue: PendingCreativeItem[];
  referrals: ReferralQueueStats;
}

export interface HouseAdRow {
  id: string;
  code: string | null;
  title: string;
  body: string;
  imageUrl: string | null;
  buttonText: string | null;
  buttonUrl: string | null;
  /** Prisma JSON column, not normalised by the service. */
  links: unknown;
  /** Always "en" — the service forces it; house posts are never localised. */
  language: string;
  weight: number;
  isActive: boolean;
  sortOrder: number;
  note: string | null;
  createdAt: string;
}

export interface BlockedDomainRow {
  id: string;
  domain: string;
  reason: string | null;
  hardBlock: boolean;
  channelId: string | null;
  createdById: string | null;
  createdAt: string;
  channel: { id: string; username: string | null } | null;
}

export type CategoryPolicyValue = 'ALLOWED' | 'REVIEW_REQUIRED' | 'BLOCKED';

/**
 * `GET /api/categories/policies` returns one entry per category (even when no
 * rule row exists, in which case `policy` is ALLOWED and `updatedAt` is null).
 */
export interface CategoryPolicyView {
  category: string;
  policy: CategoryPolicyValue;
  note: string | null;
  updatedById: string | null;
  updatedAt: string | null;
}

export interface DeliveryEventRow {
  id: string;
  deliveryJobId: string;
  type: string;
  /** SYSTEM | ADMIN | PUBLISHER (a plain string column, not an enum). */
  actorType: string;
  message: string | null;
  errorCode: string | null;
  createdAt: string;
  deliveryJob: {
    id: string;
    channel: { title: string };
    campaign: { name: string };
  };
}

export interface DeliveryTimelineEntry {
  id: string;
  type: string;
  actorType: string;
  actorId: string | null;
  message: string | null;
  errorCode: string | null;
  attempt: number;
  /** Prisma JSON column — arbitrary shape. */
  metadata: unknown;
  createdAt: string;
}

export interface CpcBillingSummary {
  posts: number;
  validClicks: number;
  billedCents: number;
  pendingSettlementCents: number;
}

/** `GET /health/queues` — live BullMQ job counts. Mounted outside /api. */
export interface QueueHealthRow {
  name: string;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
  completed: number;
}

/* ---------------------------------------------------------------
 * Aggregates (spec §7, §39–42) — GET /api/admin/analytics/*
 *
 * Every one of these is computed with Prisma groupBy/aggregate, never by
 * fetching rows, and the route converts BigInt sums before serialising. They
 * exist because the panel previously had no source for any of them: revenue by
 * day was the only aggregate on the whole surface.
 * ------------------------------------------------------------- */

export interface CampaignStatusAggregate {
  status: string;
  count: number;
  budgetTotalCents: number;
  budgetSpentCents: number;
}

export interface CampaignAnalytics {
  byStatus: CampaignStatusAggregate[];
  totals: { count: number; budgetTotalCents: number; budgetSpentCents: number };
}

export interface DeliveryAnalytics {
  byStatus: { status: string; count: number }[];
  /** Mean attempts across all jobs in the window — retry pressure at a glance. */
  avgAttempts: number;
  total: number;
}

export interface UserGrowthPoint {
  /** UTC day, "YYYY-MM-DD". */
  date: string;
  newUsers: number;
  /** Users with at least one channel. */
  publishers: number;
  /** Users with at least one campaign. */
  advertisers: number;
}

export interface UserGrowthAnalytics {
  byDay: UserGrowthPoint[];
}

export interface ChannelAnalytics {
  byStatus: { status: string; count: number }[];
  byCategory: { category: string; count: number }[];
  totals: { approved: number; attentionRequired: number; totalSubscribers: number };
}

/** The spec §86 product loop as lifetime counts. */
export interface FunnelAnalytics {
  channelsApproved: number;
  campaignsCreated: number;
  campaignsApproved: number;
  postsScheduled: number;
  postsPublished: number;
  postsFailed: number;
  earningsRows: number;
}

/* ---------- System status (§27, §28, §83) ---------- */

export type SubsystemStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';

export interface SubsystemHealth {
  /** api | database | redis | queues | telegramBot | webhook */
  name: string;
  status: SubsystemStatus;
  /** Short, safe, human sentence. Never a secret or a raw error. */
  detail: string;
  checkedAt: string;
}

/* ---------- List sorting (§79) ---------- */

/**
 * The sort keys each endpoint accepts.
 *
 * Mirrors the server's own `*_SORT_KEYS` constants (in
 * `services/admin.service.ts`, `deposit.service.ts`, `withdrawal.service.ts` and
 * `routes/admin/finance.routes.ts`). The server maps each key to an explicit
 * Prisma `orderBy` in an exhaustive switch, so an unlisted value is rejected —
 * this list only decides what the UI offers.
 */
export const SORT_KEYS = {
  users: ['created_at', 'created_at_desc', 'updated_at', 'updated_at_desc'],
  campaigns: ['created_at', 'created_at_desc', 'updated_at', 'updated_at_desc'],
  channels: ['created_at', 'created_at_desc', 'updated_at', 'updated_at_desc'],
  // Delivery sorts on scheduledAt first: that is when the post was meant to go
  // out, which is what an operator triaging a backlog cares about.
  delivery: ['scheduled_at', 'scheduled_at_desc', 'created_at', 'created_at_desc'],
  deposits: ['created_at', 'created_at_desc', 'amount', 'amount_desc'],
  withdrawals: ['created_at', 'created_at_desc', 'amount', 'amount_desc'],
  transactions: ['created_at', 'created_at_desc', 'amount', 'amount_desc'],
} as const;

export type SortableList = keyof typeof SORT_KEYS;

/** Human labels for a sort key, so the control does not show raw snake_case. */
export function sortKeyLabel(key: string): string {
  const map: Record<string, string> = {
    created_at: 'Oldest first',
    created_at_desc: 'Newest first',
    updated_at: 'Least recently updated',
    updated_at_desc: 'Recently updated',
    scheduled_at: 'Scheduled earliest',
    scheduled_at_desc: 'Scheduled latest',
    amount: 'Smallest amount',
    amount_desc: 'Largest amount',
  };
  return map[key] ?? key;
}

/* ---------------------------------------------------------------
 * Round 3 — attention feed and blocked entities
 * ------------------------------------------------------------- */

/** Order the feed is sorted in: highest first. */
export type AttentionSeverity = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

export interface AttentionItem {
  /** Stable identifier, e.g. WITHDRAWALS_PENDING. */
  kind: string;
  severity: AttentionSeverity;
  count: number;
  label: string;
  /** A real panel route. */
  href: string;
  detail: string;
}

/**
 * `GET /api/admin/attention`.
 *
 * A computed view, NOT a notification inbox: the server runs one count query per
 * source on every request, so nothing is stored and nothing can be marked read.
 * Sources with a count of 0 are omitted rather than shown as zero.
 */
export interface AttentionFeed {
  items: AttentionItem[];
  generatedAt: string;
}

/**
 * A `PublisherBlocklist` row, joined to its channel.
 *
 * Reality check against the spec: this model is per-channel and scoped
 * ADVERTISER | CAMPAIGN | CATEGORY | DOMAIN, and its free-text column is `label`,
 * not `reason`. The route maps `label` → `reason` on the wire so the UI can use
 * one word, but the two are the same column.
 */
export interface BlockedChannelRow {
  id: string;
  channelId: string;
  scope: 'ADVERTISER' | 'CAMPAIGN' | 'CATEGORY' | 'DOMAIN';
  value: string;
  reason: string | null;
  createdAt: string;
  channel: { id: string; title: string; username: string | null; status: string } | null;
}

/**
 * A non-deliverable ad post. There is no blocked-ads table: `AdPostStatus` has
 * DELETED and REJECTED but no REMOVED member, so this lists posts that are
 * DELETED/REJECTED or whose channel is on the blocklist.
 */
export interface BlockedAdRow {
  id: string;
  campaignName: string;
  channelTitle: string;
  status: string;
  /** Derived server-side: admin-block marker → moderation → status → channel block. */
  reason: string | null;
  createdAt: string;
}

/* ---------------------------------------------------------------
 * Ticket thread (admin side)
 *
 * `GET /api/admin/support/tickets/:id` is the admin twin of the owner-scoped
 * `/api/support/tickets/:id`. Same rows, minus the ownership assertion — that
 * assertion is exactly what returned a 404 to staff.
 * ------------------------------------------------------------- */

export interface AdminTicketMessage {
  id: string;
  senderId: string | null;
  /** USER | ADMIN | SYSTEM */
  senderType: string;
  body: string;
  /** Present when the sender attached a file. Already modelled; no second table. */
  attachmentUrl: string | null;
  createdAt: string;
}

export interface AdminTicketThread {
  ticket: AdminTicket;
  messages: AdminTicketMessage[];
}

/* ---------------------------------------------------------------
 * Admin notification inbox
 *
 * Reuses the existing `Notification` model and the acting admin's own user id.
 * No second notification table: an admin IS a user, and a parallel model would
 * mean two places holding one read state.
 * ------------------------------------------------------------- */

export interface AdminNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  data: unknown;
  link: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface AdminNotificationsResult {
  items: AdminNotification[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  /** Returned with the page so the list and the nav badge cannot disagree. */
  unread: number;
}

/** Declared here rather than extending the api module's `PageParams`. */
export interface AdminNotificationsQuery {
  page?: number;
  limit?: number;
  unreadOnly?: boolean;
}

/* ---------- Cross-entity search (§64) ---------- */

export interface GlobalSearchHit {
  type: 'USER' | 'CHANNEL' | 'CAMPAIGN' | 'TRANSACTION' | 'TICKET';
  id: string;
  label: string;
  sublabel: string | null;
  /** A panel route the hit can be opened at. */
  href: string;
}

export interface GlobalSearchResponse {
  results: GlobalSearchHit[];
}

/* ---------------------------------------------------------------
 * Round 4 — refunds, broadcast, per-entity analytics
 * ------------------------------------------------------------- */

/** Result of an admin-issued refund (`POST /api/admin/finance/refunds`). */
export interface RefundResult {
  transactionId: string;
  /** Ledger reference, e.g. `refund:admin:<campaignId>:<n>`. */
  reference: string;
  amountCents: number;
  campaignId: string;
  /** The advertiser's available balance after the credit. */
  newBalanceCents: number;
}

/** Who a broadcast goes to. */
export type BroadcastAudience = 'ALL' | 'PUBLISHERS' | 'ADVERTISERS';

export interface BroadcastAudienceCount {
  audience: BroadcastAudience;
  recipients: number;
}

export interface BroadcastResult {
  /** False when the request was a dry run, in which case nothing was queued. */
  enqueued: boolean;
  jobId: string | null;
  audience: BroadcastAudience;
  recipients: number;
}

/* ---------- Broadcast delivery report (§52) ---------- */

/** Mirrors the backend `BroadcastJobStatus` enum. */
export type BroadcastJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

/** Mirrors the backend `BroadcastRecipientStatus` enum. */
export type BroadcastRecipientStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

/**
 * One broadcast in the history list (`GET /api/admin/broadcast/history`).
 * `sentCount` / `failedCount` / `totalRecipients` are the job's own
 * denormalised counters — the detail view also carries live `counts`.
 */
export interface BroadcastJobSummary {
  id: string;
  status: BroadcastJobStatus;
  audience: BroadcastAudience;
  title: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  createdById: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** The full job row from `GET /api/admin/broadcast/:id` (adds the message body). */
export interface BroadcastJobDetail extends BroadcastJobSummary {
  body: string;
}

/**
 * Live per-status counts from a `groupBy` over the recipient rows. Returned
 * alongside the job on purpose: if they disagree with the denormalised columns,
 * the drift is visible instead of hidden.
 */
export interface BroadcastJobCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface BroadcastJobReport {
  job: BroadcastJobDetail;
  counts: BroadcastJobCounts;
}

/**
 * One recipient row (`GET /api/admin/broadcast/:id/recipients`).
 * `telegramMessageId` is a decimal STRING — it is a Prisma BigInt and is never
 * safe to render as a JS number.
 */
export interface BroadcastRecipientRow {
  id: string;
  userId: string;
  status: BroadcastRecipientStatus;
  telegramMessageId: string | null;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
  userName: string;
}

/* ---------- Per-entity analytics (§40, §41) ---------- */

export interface CampaignAnalyticsDetail {
  campaign: {
    id: string;
    name: string;
    status: string;
    advertiserName: string;
    createdAt: string;
    startAt: string | null;
    endAt: string | null;
  };
  budget: {
    totalCents: number;
    spentCents: number;
    reservedCents: number;
    remainingCents: number;
  };
  delivery: {
    scheduled: number;
    published: number;
    failed: number;
    cancelled: number;
    /** published / (published + failed), as a percentage. Null when nothing ran. */
    successRatePct: number | null;
  };
  reach: {
    channels: number;
    /** CPM-measured views. Zero for fixed-price campaigns — not an invented number. */
    impressions: number;
    clicks: number;
    /** clicks / impressions, as a percentage. Null when impressions is 0. */
    ctrPct: number | null;
  };
}

export interface ChannelAnalyticsDetail {
  channel: {
    id: string;
    title: string;
    username: string | null;
    status: string;
    ownerName: string;
    subscriberCount: number;
    avgViews: number;
  };
  delivery: {
    scheduled: number;
    published: number;
    failed: number;
    /** published / (published + failed), as a percentage. Null when nothing ran. */
    successRatePct: number | null;
  };
  performance: {
    posts: number;
    grossCents: number;
    netCents: number;
    platformFeeCents: number;
  };
  reach: {
    impressions: number;
    clicks: number;
    ctrPct: number | null;
  };
}

/* ---------- Generic list helpers ---------- */

export type Page<T> = Paginated<T>;

/** Shared by every filterable list: date window plus ordering. */
export interface ListQueryParams {
  page?: number;
  limit?: number;
  /** ISO date or datetime. Inclusive lower bound. */
  from?: string;
  /** ISO date or datetime. Exclusive upper bound. */
  to?: string;
  sort?: string;
}

/* ---------------------------------------------------------------
 * Round 6 - the last of the spec gaps
 * ------------------------------------------------------------- */

/** A persisted server-side error, from `GET /api/admin/errors` (spec 84). */
export interface ErrorLogRow {
  id: string;
  /** ERROR | WARN */
  level: string;
  /** HTTP | WORKER | TELEGRAM | PAYMENT | DATABASE | WEBHOOK */
  source: string;
  /** AppError.code, the error class name, or a Prisma code - the greppable bit. */
  code: string | null;
  message: string;
  /** HTTP method + route pattern, or the job name. Never a query string. */
  context: string | null;
  requestId: string | null;
  userId: string | null;
  createdAt: string;
}

export interface ErrorLogsQuery {
  page?: number;
  limit?: number;
  source?: string;
  level?: string;
  from?: string;
  to?: string;
}

/**
 * One entry in the cross-entity activity stream (spec 65).
 *
 * Computed by merging recent rows from several tables, not stored - so it can
 * never fall behind the tables it summarises.
 */
export interface ActivityItem {
  /** NEW_USER | NEW_CHANNEL | CAMPAIGN_CREATED | ... */
  kind: string;
  id: string;
  label: string;
  detail: string | null;
  /** A panel route when one exists. */
  href: string | null;
  createdAt: string;
}

export interface ActivityFeed {
  items: ActivityItem[];
  generatedAt: string;
}

/** One row of the Telegram / webhook / payment API-log view (spec 27). */
export interface ApiLogRow {
  id: string;
  source: string;
  level: string;
  code: string | null;
  message: string;
  context: string | null;
  createdAt: string;
}

export interface ApiLogsQuery {
  page?: number;
  limit?: number;
  source?: string;
  from?: string;
  to?: string;
}

/** The tables the export endpoint can produce (spec 78). */
export type ExportEntity =
  | 'users'
  | 'channels'
  | 'campaigns'
  | 'transactions'
  | 'deposits'
  | 'withdrawals'
  | 'earnings'
  | 'revenue';

export type ExportFormat = 'csv' | 'xlsx';


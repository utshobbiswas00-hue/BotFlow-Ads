/**
 * API response shapes that are not covered by the shared DTO package.
 * Mirrors the backend contract 1:1 — do not invent fields here.
 */
import { z } from 'zod';
import {
  adCreativeSchema,
  type CampaignStats,
  type CampaignSummary,
  type ChannelSummary,
  type MarketplaceChannel,
  type MarketplaceSort,
  type Paginated,
  type PricingModel,
  type TransactionRow,
  type UserProfile,
  type WalletSummary,
} from '@botflow/shared';

/* ---------- Auth / profile ---------- */

export interface MeResponse {
  user: UserProfile;
  wallet: WalletSummary;
  isAdmin: boolean;
  adminRole: string | null;
}

export interface DashboardResponse {
  balance: WalletSummary;
  channels: number;
  activeCampaigns: number;
  totalEarnedCents: number;
  totalSpentCents: number;
  pendingEarningsCents: number;
}

/* ---------- Channels ---------- */

export interface ChannelStatsPoint {
  date: string;
  subscribers: number;
  avgViews: number;
}

export interface ChannelRecentPost {
  id: string;
  status: string;
  publishedAt: string | null;
  views: number;
  clicks: number;
  publisherEarningCents: number;
}

export interface ChannelDetail extends ChannelSummary {
  /* GET /api/channels/:id returns these relation names verbatim. */
  stats: ChannelStatsPoint[];
  adPosts: ChannelRecentPost[];
  /* Detail-only fields (may be absent from minimal backends). */
  autoApprovePosts?: boolean;
  maxPostsPerDay?: number;
  minHoursBetweenAds?: number;
  verificationStatus?: string;
  /* Publisher ad-delivery switches — always present on the current backend. */
  acceptAds: boolean;
  minAdPriceCents: number;
  /* Bot's rights snapshot. Optional so the contract stays usable with a backend that
     doesn't write them; the panel defaults any missing flag to false and the banner stays. */
  botIsAdmin?: boolean;
  canPostMessages?: boolean;
  canEditMessages?: boolean;
  canDeleteMessages?: boolean;
  canInviteUsers?: boolean;
}

export interface ChannelRequest {
  id: string;
  campaignName: string;
  adText: string;
  priceCents: number;
  advertiserName: string;
  createdAt: string;
}

export type UpdateChannelBody = {
  category?: string;
  language?: string;
  country?: string;
  adPriceCents?: number;
  pricingModel?: string;
  autoApprovePosts?: boolean;
  maxPostsPerDay?: number;
  minHoursBetweenAds?: number;
  acceptAds?: boolean;
  minAdPriceCents?: number;
};

/* ---------- Publisher blocklist ---------- */

export const BLOCKLIST_SCOPES = ['ADVERTISER', 'CAMPAIGN', 'CATEGORY', 'DOMAIN'] as const;
export type BlocklistScope = (typeof BLOCKLIST_SCOPES)[number];

export interface BlocklistEntry {
  id: string;
  channelId: string;
  scope: BlocklistScope;
  value: string;
  label: string | null;
  createdAt: string;
}

/** Per-scope entry counts from GET /api/channels/:id/blocklist. */
export interface BlocklistSummary {
  ADVERTISER: number;
  CAMPAIGN: number;
  CATEGORY: number;
  DOMAIN: number;
}

export interface BlocklistResponse {
  entries: BlocklistEntry[];
  summary: BlocklistSummary;
}

export interface BlocklistAddBody {
  scope: BlocklistScope;
  value: string;
  label?: string;
}

/* ---------- Campaigns ---------- */

export type AdCreative = z.infer<typeof adCreativeSchema>;

/** Delivery breakdown as returned flat by `campaignDeliveryStats`. */
export interface CampaignDetailStats extends CampaignStats {
  awaitingApproval: number;
  cancelled: number;
  posts: number;
}

/** An ad row from GET /api/campaigns/:id (`ads` relation; carries its id). */
export type CampaignAd = AdCreative & { id?: string };

export interface CampaignDetail extends CampaignSummary {
  ads: CampaignAd[];
  stats: CampaignDetailStats;
}

export interface MarketplaceFilters {
  category?: string;
  country?: string;
  language?: string;
  minSubs?: number;
  maxSubs?: number;
  /** Inclusive price range on the channel's ad price, in cents. */
  minPriceCents?: number;
  maxPriceCents?: number;
  /** FIXED | CPM | CPC | HYBRID */
  pricingModel?: PricingModel;
  /** reach_desc | subscribers_desc | price_asc | price_desc | quality_desc */
  sort?: MarketplaceSort;
}

/**
 * Public marketplace row. Extends the shared whitelist with the delivery
 * quality fields the backend now returns; `MarketplaceChannel` itself stays
 * unchanged in the shared package.
 */
export interface MarketplaceChannelRow extends MarketplaceChannel {
  /** HEALTHY | ATTENTION_REQUIRED | RESTRICTED | SUSPENDED (may be absent pre-refresh). */
  healthStatus?: string;
  /** 0-100 delivery quality score (may be absent pre-refresh). */
  healthScore?: number;
}

/**
 * Advertiser-facing quality indicator derived from a channel's health status
 * and score. The card renders `label` + a coloured dot; `description` is the
 * tooltip an advertiser reads when they hover/tap it.
 */
export interface ChannelQuality {
  healthStatus?: string;
  healthScore?: number;
  /** Short label, e.g. "Healthy" / "Restricted". */
  label: string;
  /** Dot + text colour. */
  tone: 'green' | 'amber' | 'red' | 'gray';
  /** Plain-language explanation of what the indicator means for an ad buy. */
  description: string;
}

/**
 * Derive the quality indicator from a channel's health fields.
 * No health data yet = neutral "pending", never a false alarm.
 */
export function channelQualityOf(channel: { healthStatus?: string; healthScore?: number }): ChannelQuality {
  const { healthStatus, healthScore } = channel;
  switch (healthStatus) {
    case 'SUSPENDED':
      return {
        healthStatus,
        healthScore,
        tone: 'red',
        label: 'Suspended',
        description: 'This channel is suspended, so sponsored ads are not being delivered to it right now.',
      };
    case 'ATTENTION_REQUIRED':
      return {
        healthStatus,
        healthScore,
        tone: 'red',
        label: 'Needs attention',
        description:
          'The delivery bot may have lost posting rights in this channel, so ads may not be delivered.',
      };
    case 'RESTRICTED':
      return {
        healthStatus,
        healthScore,
        tone: 'red',
        label: 'Restricted',
        description:
          'Recent delivery failures or unresolved reports — new ads are restricted on this channel until it recovers.',
      };
    case 'HEALTHY': {
      if (healthScore !== undefined && healthScore < 80) {
        return {
          healthStatus,
          healthScore,
          tone: 'amber',
          label: 'Stable',
          description: `Ads are being delivered; quality score ${healthScore}/100 reflects some recent failed posts.`,
        };
      }
      return {
        healthStatus,
        healthScore,
        tone: 'green',
        label: 'Healthy',
        description:
          healthScore !== undefined
            ? `Ads are being delivered reliably. Quality score ${healthScore}/100.`
            : 'Ads are being delivered reliably.',
      };
    }
    default:
      return {
        healthStatus,
        healthScore,
        tone: 'gray',
        label: 'Quality pending',
        description: 'Delivery quality is being checked — no score for this channel yet.',
      };
  }
}

/* ---------- Wallet ---------- */

export interface DepositRow {
  id: string;
  amountCents: number;
  method: string;
  status: string;
  createdAt: string;
  /** What the rail keeps. The depositor pays it, so `amountCents` > credit. */
  feeBps?: number;
  feeCents?: number;
}

/**
 * One (asset, chain) pair an operator has configured an address for.
 *
 * Only configured networks ever appear: a pair with no address is ABSENT from
 * the API response rather than present with an empty address, because sending to
 * the wrong chain is unrecoverable.
 */
export interface CryptoDepositNetwork {
  network: string;
  asset: string;
  chain: string;
  address: string;
  memo: string | null;
}

/**
 * What a top-up costs and what actually lands.
 *
 * Every quote carries both, because the depositor pays the fee: at Telegram
 * Stars' 48% the credited figure is less than half of what they are charged, and
 * showing only the charge would be misleading.
 */
export interface DepositQuote {
  grossCents: number;
  feeBps: number;
  feeCents: number;
  creditedCents: number;
}

export interface StarsDepositQuote extends DepositQuote {
  depositId: string;
  stars: number;
}

/**
 * POST /api/deposits/gateway session. The quote source uses `grossCents`
 * internally, but the route renames the charged amount to `amountCents` — so
 * this rail is NOT a `DepositQuote` (unlike the Stars rail, which returns
 * `grossCents`).
 */

export interface WithdrawalRow {
  id: string;
  amountCents: number;
  feeCents: number;
  netAmountCents: number;
  method: string;
  status: string;
  createdAt: string;
  rejectReason: string | null;
}

export type { TransactionRow };

/* ---------- Referrals / notifications ---------- */

export interface ReferralRow {
  name: string;
  status: string;
  rewardCents: number;
  createdAt: string;
}

export interface ReferralsResponse {
  referralCode: string;
  totalReferrals: number;
  totalRewardedCents: number;
  referrals: Paginated<ReferralRow>;
}

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
  /** Optional server-side category (e.g. "Campaign"). Derived from `type` when absent. */
  category?: string;
}

export interface UnreadCount {
  count: number;
}

/* ---------- Metrics (provenance) ---------- */

export type MetricProvenance = 'TRACKED' | 'REPORTED' | 'ESTIMATED';

export interface Metric {
  key: string;
  label: string;
  value: number | null;
  provenance: MetricProvenance;
  /** Explains the figure — for null values it reads e.g. "Not available from Telegram". */
  note?: string;
}

/** Provenance badge copy — the API returns `{ label, tone }`, not a string. */
export interface MetricBadge {
  label: string;
  tone: string;
}

export interface MetricsLegend {
  tracked?: MetricBadge | string;
  reported?: MetricBadge | string;
  estimated?: MetricBadge | string;
}

export interface MetricsResponse {
  tracked: Metric[];
  reported: Metric[];
  estimated: Metric[];
  legend?: MetricsLegend;
  /** Footer line shown under the sections. */
  note?: string;
}

/* ---------- Premium analytics ---------- */

/**
 * `GET /api/analytics/advertiser/history?days=N` — PREMIUM only.
 * backend/src/routes/analytics.routes.ts:44 + backend/src/services/analytics.service.ts:205.
 * A free advertiser gets a typed 403 (`FORBIDDEN`, `premiumRequired`)
 * (analytics.service.ts:155), which the UI turns into an upgrade prompt.
 *
 * Array/object fields are optional so a partial or empty window can never
 * trigger `undefined.map`.
 */
export interface AdvertiserHistoryDay {
  date: string;
  posts: number;
  views: number;
  clicks: number;
  spendCents: number;
}

export interface AdvertiserHistoryChannel {
  channelId: string;
  title: string;
  posts: number;
  views: number;
  clicks: number;
}

export interface AdvertiserHistory {
  /** Window actually applied, after clamping. */
  days?: number;
  from?: string;
  to?: string;
  daily?: AdvertiserHistoryDay[];
  totals?: {
    posts?: number;
    views?: number;
    clicks?: number;
    spendCents?: number;
    /** Percent, 2dp — same convention as the free summary. */
    ctr?: number;
  };
  topChannels?: AdvertiserHistoryChannel[];
}

/* ---------- Category policies ---------- */

export type CategoryPolicyState = 'ALLOWED' | 'REVIEW_REQUIRED' | 'BLOCKED';

export interface CategoryPolicy {
  category: string;
  policy: CategoryPolicyState;
  note?: string;
}

/* ---------- URL validation ---------- */

export interface UrlValidation {
  ok: boolean;
  hardBlock: boolean;
  reasons: string[];
  normalized?: string;
  domain?: string;
}

/* ---------- Benefits / slot mix ---------- */

export interface SlotMix {
  paidPercent: number;
  housePercent: number;
  summary?: string;
  publisherNote?: string;
}

/* ---------- Support ---------- */

export interface TicketRow {
  id: string;
  ticketNo: string;
  subject: string;
  category?: string | null;
  status: string;
  lastMessageAt: string;
}

export interface TicketMessage {
  id: string;
  body: string;
  senderType: string;
  createdAt: string;
}

export interface TicketDetail {
  ticket: TicketRow;
  messages: TicketMessage[];
}

/* ---------- Settings ---------- */

export type SettingsMap = Record<string, unknown>;

/* ---------- Admin ---------- */

export interface AdminDashboard {
  totalUsers: number;
  activeUsers: number;
  advertisers: number;
  publishers: number;
  approvedChannels: number;
  activeCampaigns: number;
  todayRevenueCents: number;
  totalRevenueCents: number;
  pendingDeposits: number;
  pendingWithdrawals: number;
  pendingCampaigns: number;
  failedDeliveries: number;
  fraudAlerts: number;
}

export interface AdminCampaignRow extends CampaignSummary {
  advertiserName: string;
}

export interface AdminChannelRow extends ChannelSummary {
  ownerName: string;
}

export interface AdminUserRow extends UserProfile {
  /**
   * The recorded reason for a suspension or ban. Selected by the backend's
   * ADMIN_USER_SELECT so the dossier can show WHY an account is suspended, not
   * just that it is.
   */
  suspendedReason?: string | null;
  balanceCents: number;
}

export interface AdminDeliveryRow {
  id: string;
  campaignName: string;
  channelTitle: string;
  status: string;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  scheduledAt: string | null;
}

export interface AdminDeliveryStats {
  total: number;
  published: number;
  pending: number;
  failed: number;
  awaitingApproval: number;
}

export interface AdminDepositRow {
  id: string;
  userName: string;
  amountCents: number;
  method: string;
  status: string;
  proofUrl: string | null;
  createdAt: string;
}

export interface AdminWithdrawalRow {
  id: string;
  userName: string;
  amountCents: number;
  netAmountCents: number;
  method: string;
  status: string;
  accountMasked: string;
  createdAt: string;
  rejectReason?: string | null;
}

export interface RevenueSeries {
  byDay: { date: string; revenueCents: number }[];
}

export interface AdminReportRow {
  id: string;
  reporterName: string;
  reason: string;
  details: string | null;
  status: string;
  createdAt: string;
}


/* ---------------------------------------------------------------
 *  Channel onboarding — the publisher's 4-state view.
 * --------------------------------------------------------------- */

export type PublisherOnboardingStage =
  | 'NO_ACCESS'
  | 'ON_HOLD'
  | 'PENDING_REVIEW'
  | 'NEEDS_GROWTH'
  | 'ACTIVE'
  | 'SUSPENDED';

export interface ChannelOnboarding {
  publisherStage: PublisherOnboardingStage;
  botHasAccess: boolean;
  meetsMarketplaceFloor: boolean;
  status: string;
  subscribers: number;
  minSubscribers: number;
  /** @username without leading `@`, or null for invite-link channels. */
  username: string | null;
  /** Telegram's numeric channel id — used as the deep-link fallback. */
  telegramChannelId: string;
}

/* ---------------------------------------------------------------
 *  AI Assistant (GET /api/ai/history, POST /api/ai/chat).
 *  The backend message is `AiMessage` (role includes 'tool'); the UI only
 *  renders user/assistant turns, so `useAiChat` normalises to this shape.
 * --------------------------------------------------------------- */

export interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

export interface AiChatToolCall {
  name: string;
  args: unknown;
  result: string;
}

export interface AiChatReply {
  reply: string;
  toolCalls: AiChatToolCall[];
}

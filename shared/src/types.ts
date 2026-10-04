/* Shared DTO shapes — the contract between backend responses and frontend. */

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface UserProfile {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  status: string;
  isAdvertiser: boolean;
  isPublisher: boolean;
  referralCode: string;
  totalEarnedCents: number;
  totalSpentCents: number;
  totalWithdrawnCents: number;
  totalDepositedCents: number;
  createdAt: string;
  isAdmin: boolean;
  adminRole: string | null;
}

export interface WalletSummary {
  availableCents: number;
  reservedCents: number;
  pendingCents: number;
  currency: string;
  totalDepositedCents: number;
  totalSpentCents: number;
  totalEarnedCents: number;
  totalWithdrawnCents: number;
  totalRefundedCents: number;
}

export interface ChannelSummary {
  id: string;
  telegramChannelId: string;
  username: string | null;
  title: string;
  photoUrl: string | null;
  category: string;
  language: string | null;
  country: string | null;
  subscriberCount: number;
  avgViews: number;
  status: string;
  /* The bot's rights in the channel. Older backends may not write them; the
     panel treats a missing flag as `false` so the banner stays meaningful. */
  canPostMessages?: boolean;
  botIsAdmin?: boolean;
  canEditMessages?: boolean;
  canDeleteMessages?: boolean;
  canInviteUsers?: boolean;
  pricingModel: string;
  adPriceCents: number;
  totalAdsPublished: number;
  totalEarnedCents: number;
  rejectionReason?: string | null;

  /**
   * The publisher's weekly posting schedule: weekday ("0" = Sunday) -> the
   * channel-local times a sponsored post may go out at. `null`/absent means no
   * schedule is set, and only `maxPostsPerDay` + `minHoursBetweenAds` apply.
   */
  postingSchedule?: Record<string, string[]> | null;
  maxPostsPerDay?: number;
  minHoursBetweenAds?: number;
  acceptAds?: boolean;
  autoApprovePosts?: boolean;
  minAdPriceCents?: number;
}

export interface CampaignSummary {
  id: string;
  name: string;
  status: string;
  promotionTarget: string;
  pricingModel: string;
  budgetTotalCents: number;
  budgetSpentCents: number;
  budgetReservedCents: number;
  frequencyPerChannel: number;
  isAutoTargeting: boolean;
  startAt: string | null;
  endAt: string | null;
  createdAt: string;
  stats?: CampaignStats;
}

export interface CampaignStats {
  targetChannels: number;
  published: number;
  pending: number;
  failed: number;
  views: number;
  clicks: number;
  ctr: number;
  remainingBudgetCents: number;
}

export interface AnalyticsSummary {
  totalSpendCents: number;
  totalPosts: number;
  totalViews: number;
  totalClicks: number;
  ctr: number;
  activeChannels: number;
  completedChannels: number;
  remainingBudgetCents: number;
}

export interface PublisherAnalytics {
  sponsoredPosts: number;
  totalViews: number;
  totalClicks: number;
  ctr: number;
  totalEarningsCents: number;
  pendingEarningsCents: number;
  availableBalanceCents: number;
  paidEarningsCents: number;
}

export interface TransactionRow {
  id: string;
  type: string;
  status: string;
  amountCents: number;
  currency: string;
  description: string | null;
  reference: string;
  createdAt: string;
}

export interface MarketplaceChannel {
  id: string;
  title: string;
  username: string | null;
  photoUrl: string | null;
  category: string;
  country: string | null;
  language: string | null;
  subscriberCount: number;
  avgViews: number;
  adPriceCents: number;
  pricingModel: string;
}

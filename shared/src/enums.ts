/**
 * Status & type enums mirrored from backend/prisma/schema.prisma.
 * Kept as plain const objects so the frontend never imports Prisma.
 */

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  PENDING_REVIEW: 'PENDING_REVIEW',
  SUSPENDED: 'SUSPENDED',
  BANNED: 'BANNED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const AdminRole = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  MODERATOR: 'MODERATOR',
  FINANCE_MANAGER: 'FINANCE_MANAGER',
  SUPPORT_AGENT: 'SUPPORT_AGENT',
  ANALYST: 'ANALYST',
} as const;
export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

export const ChannelStatus = {
  PENDING: 'PENDING',
  // Publisher granted every bot permission but has not yet submitted the channel
  // for moderator review. APPROVED is what comes after a moderator signs off;
  // the wait-state belongs to neither group, hence its own value.
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
  INACTIVE: 'INACTIVE',
  ATTENTION_REQUIRED: 'ATTENTION_REQUIRED',
} as const;
export type ChannelStatus = (typeof ChannelStatus)[keyof typeof ChannelStatus];

export const CHANNEL_CATEGORIES = [
  'NEWS',
  'TECHNOLOGY',
  'EDUCATION',
  'ENTERTAINMENT',
  'GAMING',
  'BUSINESS',
  'SHOPPING',
  'DEALS',
  'JOBS',
  'SPORTS',
  'CRYPTO',
  'COMMUNITY',
  'OTHER',
] as const;
export type ChannelCategory = (typeof CHANNEL_CATEGORIES)[number];

export const PricingModel = {
  FIXED: 'FIXED',
  CPM: 'CPM',
  CPC: 'CPC',
  HYBRID: 'HYBRID',
} as const;
export type PricingModel = (typeof PricingModel)[keyof typeof PricingModel];

export const CampaignStatus = {
  DRAFT: 'DRAFT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  SCHEDULED: 'SCHEDULED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  SUSPENDED: 'SUSPENDED',
} as const;
export type CampaignStatus = (typeof CampaignStatus)[keyof typeof CampaignStatus];

export const AdFormat = {
  TEXT: 'TEXT',
  IMAGE: 'IMAGE',
  IMAGE_TEXT: 'IMAGE_TEXT',
  BUTTON: 'BUTTON',
} as const;
export type AdFormat = (typeof AdFormat)[keyof typeof AdFormat];

export const PromotionTarget = {
  CHANNEL: 'CHANNEL',
  GROUP: 'GROUP',
  BOT: 'BOT',
  WEBSITE: 'WEBSITE',
  PRODUCT: 'PRODUCT',
  SERVICE: 'SERVICE',
  APP: 'APP',
  BRAND: 'BRAND',
} as const;
export type PromotionTarget = (typeof PromotionTarget)[keyof typeof PromotionTarget];

export const AdPostStatus = {
  QUEUED: 'QUEUED',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  PROCESSING: 'PROCESSING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  RETRYING: 'RETRYING',
  REJECTED: 'REJECTED',
  DELETED: 'DELETED',
} as const;
export type AdPostStatus = (typeof AdPostStatus)[keyof typeof AdPostStatus];

export const DeliveryJobStatus = {
  PENDING: 'PENDING',
  SCHEDULED: 'SCHEDULED',
  LOCKED: 'LOCKED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  RETRYING: 'RETRYING',
  CANCELLED: 'CANCELLED',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
} as const;
export type DeliveryJobStatus = (typeof DeliveryJobStatus)[keyof typeof DeliveryJobStatus];

export const TransactionType = {
  DEPOSIT: 'DEPOSIT',
  CAMPAIGN_CHARGE: 'CAMPAIGN_CHARGE',
  PUBLISHER_EARNING: 'PUBLISHER_EARNING',
  WITHDRAWAL: 'WITHDRAWAL',
  REFUND: 'REFUND',
  PLATFORM_FEE: 'PLATFORM_FEE',
  REFERRAL_REWARD: 'REFERRAL_REWARD',
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
  ESCROW_HOLD: 'ESCROW_HOLD',
  ESCROW_RELEASE: 'ESCROW_RELEASE',
} as const;
export type TransactionType = (typeof TransactionType)[keyof typeof TransactionType];

export const TransactionStatus = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REVERSED: 'REVERSED',
} as const;
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

export const DepositStatus = {
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
} as const;
export type DepositStatus = (typeof DepositStatus)[keyof typeof DepositStatus];

export const WithdrawalStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  PROCESSING: 'PROCESSING',
  PAID: 'PAID',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;
export type WithdrawalStatus = (typeof WithdrawalStatus)[keyof typeof WithdrawalStatus];

export const EarningStatus = {
  PENDING: 'PENDING',
  AVAILABLE: 'AVAILABLE',
  PAID: 'PAID',
  REVERSED: 'REVERSED',
} as const;
export type EarningStatus = (typeof EarningStatus)[keyof typeof EarningStatus];

export const TicketStatus = {
  OPEN: 'OPEN',
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

export const TicketPriority = {
  LOW: 'LOW',
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
  URGENT: 'URGENT',
} as const;
export type TicketPriority = (typeof TicketPriority)[keyof typeof TicketPriority];

export const ReportReason = {
  SCAM: 'SCAM',
  SPAM: 'SPAM',
  MISLEADING: 'MISLEADING',
  BROKEN_LINK: 'BROKEN_LINK',
  INAPPROPRIATE: 'INAPPROPRIATE',
  OTHER: 'OTHER',
} as const;
export type ReportReason = (typeof ReportReason)[keyof typeof ReportReason];

export const ReportStatus = {
  OPEN: 'OPEN',
  REVIEWING: 'REVIEWING',
  RESOLVED: 'RESOLVED',
  DISMISSED: 'DISMISSED',
} as const;
export type ReportStatus = (typeof ReportStatus)[keyof typeof ReportStatus];

export const NotificationType = {
  CAMPAIGN_APPROVED: 'CAMPAIGN_APPROVED',
  CAMPAIGN_REJECTED: 'CAMPAIGN_REJECTED',
  CAMPAIGN_STARTED: 'CAMPAIGN_STARTED',
  CAMPAIGN_COMPLETED: 'CAMPAIGN_COMPLETED',
  CAMPAIGN_PAUSED: 'CAMPAIGN_PAUSED',
  BUDGET_LOW: 'BUDGET_LOW',
  NEW_AD_REQUEST: 'NEW_AD_REQUEST',
  AD_PUBLISHED: 'AD_PUBLISHED',
  EARNINGS_ADDED: 'EARNINGS_ADDED',
  WITHDRAWAL_APPROVED: 'WITHDRAWAL_APPROVED',
  WITHDRAWAL_PROCESSING: 'WITHDRAWAL_PROCESSING',
  WITHDRAWAL_PAID: 'WITHDRAWAL_PAID',
  WITHDRAWAL_REJECTED: 'WITHDRAWAL_REJECTED',
  DEPOSIT_VERIFIED: 'DEPOSIT_VERIFIED',
  CHANNEL_APPROVED: 'CHANNEL_APPROVED',
  CHANNEL_REJECTED: 'CHANNEL_REJECTED',
  CHANNEL_PERMISSION_PROBLEM: 'CHANNEL_PERMISSION_PROBLEM',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
  FRAUD_ALERT: 'FRAUD_ALERT',
  SYSTEM: 'SYSTEM',
  /** Publisher money finished its hold period and is now withdrawable. */
  EARNINGS_AVAILABLE: 'EARNINGS_AVAILABLE',
  /** Sign-in or sensitive change from a device we have not seen before. */
  SECURITY_ALERT: 'SECURITY_ALERT',
  /** A billing-period invoice has been issued. */
  INVOICE_READY: 'INVOICE_READY',
  /** A conversion was attributed to one of the advertiser's campaigns. */
  CONVERSION_RECORDED: 'CONVERSION_RECORDED',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const FraudType = {
  CLICK_FLOOD: 'CLICK_FLOOD',
  DUPLICATE_CLICK: 'DUPLICATE_CLICK',
  SELF_CLICK: 'SELF_CLICK',
  ABNORMAL_CTR: 'ABNORMAL_CTR',
  REFERRAL_ABUSE: 'REFERRAL_ABUSE',
  MULTI_ACCOUNT: 'MULTI_ACCOUNT',
  AUTOMATED_ACTIVITY: 'AUTOMATED_ACTIVITY',
  SUSPICIOUS_ACCOUNT: 'SUSPICIOUS_ACCOUNT',
} as const;
export type FraudType = (typeof FraudType)[keyof typeof FraudType];

export const FraudSeverity = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type FraudSeverity = (typeof FraudSeverity)[keyof typeof FraudSeverity];

export const DeliveryErrorCode = {
  BOT_NOT_ADMIN: 'BOT_NOT_ADMIN',
  MISSING_POST_PERMISSION: 'MISSING_POST_PERMISSION',
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  CHANNEL_UNAVAILABLE: 'CHANNEL_UNAVAILABLE',
  TELEGRAM_API_ERROR: 'TELEGRAM_API_ERROR',
  CHAT_WRITE_FORBIDDEN: 'CHAT_WRITE_FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  CHANNEL_SUSPENDED: 'CHANNEL_SUSPENDED',
  PUBLISHER_REJECTED: 'PUBLISHER_REJECTED',
  /** A post-guarding policy check could not be evaluated — the post was not published. */
  POLICY_CHECK_UNAVAILABLE: 'POLICY_CHECK_UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type DeliveryErrorCode = (typeof DeliveryErrorCode)[keyof typeof DeliveryErrorCode];

/* ---------------------------------------------------------------
 *  Advertiser programmatic access
 * --------------------------------------------------------------- */

export const ApiKeyScope = {
  /** Read the advertiser's own campaigns, metrics and invoices. */
  READ: 'READ',
  /** Create/update campaigns and report conversions back. */
  WRITE: 'WRITE',
} as const;
export type ApiKeyScope = (typeof ApiKeyScope)[keyof typeof ApiKeyScope];

/**
 * Events a webhook endpoint can subscribe to.
 *
 * A closed list on purpose: an endpoint that subscribes to a misspelt event
 * silently never fires, and a silent no-show is far harder to debug than a
 * validation error at creation time.
 */
export const WebhookEvent = {
  CAMPAIGN_APPROVED: 'CAMPAIGN_APPROVED',
  CAMPAIGN_REJECTED: 'CAMPAIGN_REJECTED',
  CAMPAIGN_STARTED: 'CAMPAIGN_STARTED',
  CAMPAIGN_COMPLETED: 'CAMPAIGN_COMPLETED',
  POST_PUBLISHED: 'POST_PUBLISHED',
  POST_FAILED: 'POST_FAILED',
  BUDGET_LOW: 'BUDGET_LOW',
  CONVERSION_RECORDED: 'CONVERSION_RECORDED',
  INVOICE_ISSUED: 'INVOICE_ISSUED',
  EARNINGS_SETTLED: 'EARNINGS_SETTLED',
  CHANNEL_APPROVED: 'CHANNEL_APPROVED',
  CHANNEL_REJECTED: 'CHANNEL_REJECTED',
  /** Sent immediately on endpoint creation so the signature can be verified. */
  TEST: 'TEST',
} as const;
export type WebhookEvent = (typeof WebhookEvent)[keyof typeof WebhookEvent];

export const WEBHOOK_EVENT_LIST: readonly string[] = Object.values(WebhookEvent);

export const WebhookDeliveryStatus = {
  PENDING: 'PENDING',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  /** Retries exhausted; the endpoint is disabled so we stop hammering a dead URL. */
  EXHAUSTED: 'EXHAUSTED',
} as const;
export type WebhookDeliveryStatus =
  (typeof WebhookDeliveryStatus)[keyof typeof WebhookDeliveryStatus];

export const InvoiceStatus = {
  DRAFT: 'DRAFT',
  ISSUED: 'ISSUED',
  PAID: 'PAID',
  VOID: 'VOID',
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

/* ---------------------------------------------------------------
 *  Marketplace browsing
 * --------------------------------------------------------------- */

export const MARKETPLACE_SORTS = [
  'reach_desc',
  'subscribers_desc',
  'price_asc',
  'price_desc',
  'quality_desc',
] as const;
export type MarketplaceSort = (typeof MARKETPLACE_SORTS)[number];

/**
 * The pricing models as a value list, derived from the `PricingModel` object
 * above so there is exactly one source of truth. zod's `z.enum` needs a tuple of
 * literals, which is what this gives it.
 */
export const PRICING_MODELS = Object.values(PricingModel) as [PricingModel, ...PricingModel[]];

/* ---------------------------------------------------------------
 *  Payment methods and what each one costs
 *
 *  A closed list on purpose. Every method carries a rate, and an
 *  unknown/typo'd method would silently be treated as free — so a
 *  method has to be one we have a rate for.
 *
 *  Lowercase on purpose: these strings are already persisted in
 *  `deposits.method`, so the vocabulary must not change under existing
 *  rows.
 * --------------------------------------------------------------- */

export const PAYMENT_METHODS = [
  'crypto',
  'telegram_stars',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * The cut taken from each deposit, in basis points (100 bps = 1%).
 *
 * THE DEPOSITOR PAYS THE FEE. It is deducted from what they sent, and only the
 * remainder reaches their wallet:
 *
 *     they send 100  →  feeBps 4800  →  fee 48 kept, 52 credited
 *
 * So the advertiser funds less than they paid — which is why the fee is frozen
 * on the deposit row and shown back to them before they pay. A rate that only
 * existed at settlement time would take money the depositor never agreed to.
 *
 * Operator-supplied rates. These are the defaults and can be overridden per
 * method at runtime (`payment_fee_bps_<method>`) because a processor can change
 * its pricing without asking us.
 */
export const PAYMENT_METHOD_FEE_BPS: Record<PaymentMethod, number> = {
  crypto: 0,
  telegram_stars: 4800,
};

/** Human labels for the deposit picker. */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  crypto: 'Crypto',
  telegram_stars: 'Telegram Stars',
};

/** True when `value` is a method we have an economics rate for. */
export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------
 *  Crypto networks
 *
 *  One entry per (asset, chain) pair the deposit screen offers. The pair
 *  matters, not the asset alone: USDT on TON and USDT on BEP20 are different
 *  addresses, and sending to the wrong one loses the money with no recourse.
 * --------------------------------------------------------------- */

export const CRYPTO_NETWORKS = [
  'USDT_TON',
  'TON',
  'USDT_BEP20',
  'USDT_TRC20',
  'USDT_ERC20',
  'USDC_TON',
  'USDC_TRC20',
  'USDC_ERC20',
  'BTC',
] as const;
export type CryptoNetwork = (typeof CRYPTO_NETWORKS)[number];

/** What the depositor sees: asset on top, chain underneath. */
export const CRYPTO_NETWORK_LABELS: Record<CryptoNetwork, { asset: string; chain: string }> = {
  USDT_TON: { asset: 'USDT', chain: 'TON' },
  TON: { asset: 'TON', chain: 'TON' },
  USDT_BEP20: { asset: 'USDT', chain: 'BEP20' },
  USDT_TRC20: { asset: 'USDT', chain: 'TRC20' },
  USDT_ERC20: { asset: 'USDT', chain: 'ERC20' },
  USDC_TON: { asset: 'USDC', chain: 'TON' },
  USDC_TRC20: { asset: 'USDC', chain: 'TRC20' },
  USDC_ERC20: { asset: 'USDC', chain: 'ERC20' },
  BTC: { asset: 'Bitcoin', chain: 'Bitcoin' },
};

/** True when `value` is a (asset, chain) pair we can generate an address for. */
export function isCryptoNetwork(value: unknown): value is CryptoNetwork {
  return typeof value === 'string' && (CRYPTO_NETWORKS as readonly string[]).includes(value);
}

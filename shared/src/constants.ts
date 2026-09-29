/**
 * Frontend-facing constants. Keep in sync with backend/src/config/constants.ts
 */

/**
 * BullMQ queue names.
 * NOTE: BullMQ v5 rejects a colon inside a queue name ("Queue name cannot
 * contain :"), so names use a hyphen separator even though the Redis keys
 * BullMQ generates internally are prefixed with `bull:`.
 */
export const QUEUE_NAMES = {
  DELIVERY: 'botflow-delivery',
  SCHEDULER: 'botflow-scheduler',
  PERMISSION: 'botflow-permission',
  STATS: 'botflow-stats',
  PAYOUT: 'botflow-payout',
  WITHDRAWAL: 'botflow-withdrawal',
  FRAUD: 'botflow-fraud',
  NOTIFICATION: 'botflow-notification',
  CLEANUP: 'botflow-cleanup',
  /// Outbound webhooks to advertisers. Separate from NOTIFICATION (which pushes
  /// to Telegram) because a slow or dead subscriber endpoint must never delay a
  /// user-facing message, and because retries are longer-lived.
  WEBHOOK: 'botflow-webhook',
} as const;

export const DEFAULT_CURRENCY = 'USD';

/** Platform fee percent applied to every publisher earning. */
export const DEFAULT_PLATFORM_FEE_PERCENT = 20;

export const MIN_CAMPAIGN_BUDGET_CENTS = 500; // $5.00
export const MIN_WITHDRAWAL_CENTS = 500; // $5.00
export const MAX_WITHDRAWAL_CENTS = 100_000; // $1,000.00
export const REFERRAL_REWARD_CENTS = 100; // $1.00
export const EARNING_HOLD_HOURS = 24;

export const MAX_FREQUENCY_PER_CHANNEL = 3;
export const DEFAULT_MAX_POSTS_PER_DAY = 3;
export const DEFAULT_MIN_HOURS_BETWEEN_ADS = 4;

/** Telegram sendMessage text limit. */
export const TELEGRAM_MAX_TEXT_LENGTH = 4096;
/** Telegram caption limit for media messages. */
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

export const SPONSORED_LABEL = '📢 Sponsored';

/**
 * Support contact for a human follow-up. Kept in one place so the bot, the Mini
 * App and every error message name the same handle. An admin can override it at
 * runtime with the `support_username` setting; this is the fallback.
 */
export const SUPPORT_USERNAME = 'Botflowsapport';
export const SUPPORT_URL = `https://t.me/${SUPPORT_USERNAME}`;

export const PAGINATION = {
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

export const CACHE_TTL = {
  SETTINGS: 60,
  CHANNEL_STATS: 300,
  MARKETPLACE: 60,
  USER_SESSION: 3600,
} as const;

export const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24; // 24h

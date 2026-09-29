/**
 * Backend constants.
 * Business defaults live in the DB `settings` table and can be overridden
 * at runtime from the Admin Panel. These values are the code-level fallbacks.
 */

export * from '@botflow/shared';

export const SETTING_KEYS = {
  PLATFORM_FEE_PERCENT: 'platform_fee_percent',
  MIN_WITHDRAWAL_CENTS: 'min_withdrawal_cents',
  MAX_WITHDRAWAL_CENTS: 'max_withdrawal_cents',
  WITHDRAWAL_FEE_CENTS: 'withdrawal_fee_cents',
  MIN_CAMPAIGN_BUDGET_CENTS: 'min_campaign_budget_cents',
  MIN_CHANNEL_POST_PRICE_CENTS: 'min_channel_post_price_cents',
  MAX_CHANNEL_POST_PRICE_CENTS: 'max_channel_post_price_cents',
  EARNING_HOLD_HOURS: 'earning_hold_hours',
  PUBLISHER_APPROVAL_TIMEOUT_HOURS: 'publisher_approval_timeout_hours',
  ADVERTISER_CHANNEL_COOLDOWN_HOURS: 'advertiser_channel_cooldown_hours',
  DUPLICATE_AD_DETECTION_HOURS: 'duplicate_ad_detection_hours',
  PLATFORM_MAX_ADS_PER_CHANNEL_PER_DAY: 'platform_max_ads_per_channel_per_day',

  // ---- Publisher CPM payout ------------------------------------------
  /// What a publisher EARNS per 1,000 measured views. 180 cents = $1.80.
  PUBLISHER_CPM_RATE_CENTS: 'publisher_cpm_rate_cents',
  PUBLISHER_CPM_ENABLED: 'publisher_cpm_enabled',
  /// Where post views come from. 'none' = we cannot measure, so no CPM payout.
  VIEW_SOURCE: 'view_source',

  // ---- Premium --------------------------------------------------------
  PREMIUM_ENABLED: 'premium_enabled',
  PREMIUM_FREE_MAX_CHANNELS: 'premium_free_max_channels',
  PREMIUM_FREE_MAX_ACTIVE_CAMPAIGNS: 'premium_free_max_active_campaigns',
  PREMIUM_FREE_DAILY_WITHDRAW_LIMIT_CENTS: 'premium_free_daily_withdraw_limit_cents',
  /// The rest of the FREE baseline, so an admin can tune the free tier from the
  /// panel instead of shipping a deploy. Defaults preserve today's behaviour.
  PREMIUM_FREE_MONTHLY_WITHDRAW_LIMIT_CENTS: 'premium_free_monthly_withdraw_limit_cents',
  PREMIUM_FREE_MAX_CAMPAIGN_BUDGET_CENTS: 'premium_free_max_campaign_budget_cents',
  PREMIUM_FREE_CHANNEL_COOLDOWN_HOURS: 'premium_free_channel_cooldown_hours',
  PREMIUM_FREE_MAX_CAMPAIGNS_PER_HOUR: 'premium_free_max_campaigns_per_hour',

  /// Support contact shown in the bot and the Mini App.
  SUPPORT_USERNAME: 'support_username',

  // ---- Advertiser pricing: a budget buys an ESTIMATED REACH -------------
  /// What an advertiser pays per 1,000 estimated reach, in cents.
  /// 33 cents means $10 buys about 30,300 reach, shown as a 25k-40k band.
  ADVERTISER_CPM_CENTS: 'advertiser_cpm_cents',
  /// The band shown to the advertiser, as a percentage of the midpoint.
  REACH_FLOOR_PERCENT: 'reach_floor_percent',
  REACH_CEIL_PERCENT: 'reach_ceil_percent',
  /// What "reach" is measured in: subscribers (default) or avg_views.
  REACH_BASIS: 'reach_basis',
  /// Minimum advertiser budget.
  MIN_ADVERTISER_BUDGET_CENTS: 'min_advertiser_budget_cents',

  // ---- Paid / house slot mix -------------------------------------------
  /// Share of sponsored slots that carry a paying advertiser's creative.
  PAID_AD_SHARE_PERCENT: 'paid_ad_share_percent',
  /// Share reserved for BotFlow's own promotions.
  HOUSE_AD_SHARE_PERCENT: 'house_ad_share_percent',
  /// What a publisher is paid for a HOUSE slot, as a percentage of the normal
  /// CPM rate. 100 = house slots pay the publisher exactly like paid ones.
  HOUSE_AD_PUBLISHER_SHARE_PERCENT: 'house_ad_publisher_share_percent',

  // ---- Monetization eligibility ----------------------------------------
  /// A channel needs at least this many subscribers before its owner can
  /// monetize. Below it the channel earns nothing, by product rule.
  MIN_SUBSCRIBERS_FOR_MONETIZATION: 'min_subscribers_for_monetization',
  /// Whether a below-threshold channel may still receive posts at all.
  BELOW_THRESHOLD_RECEIVES_POSTS: 'below_threshold_receives_posts',
  /// Language every house (platform) post is written in. Fixed to English.
  HOUSE_AD_LANGUAGE: 'house_ad_language',
  /// Hours of silence in a channel before the bot fills the gap with a house post.
  HOUSE_POST_IDLE_HOURS: 'house_post_idle_hours',
  /// Ceiling on what the platform will pay a publisher for ONE house post.
  /// House posts have no advertiser funding them, so the cost is bounded here.
  HOUSE_POST_PAYOUT_CAP_CENTS: 'house_post_payout_cap_cents',
  REFERRAL_REWARD_CENTS: 'referral_reward_cents',
  AUTO_APPROVE_CAMPAIGNS: 'auto_approve_campaigns',
  AUTO_APPROVE_CHANNELS: 'auto_approve_channels',
  MAINTENANCE_MODE: 'maintenance_mode',
  MAINTENANCE_MESSAGE: 'maintenance_message',
  MIN_WITHDRAWAL_METHODS: 'allowed_withdrawal_methods',
  ALLOWED_DEPOSIT_METHODS: 'allowed_deposit_methods',
  MAX_CLICKS_PER_USER_PER_MINUTE: 'max_clicks_per_user_per_minute',

  // ---- Payout limits & referral guardrails (payoutLimits.service) ---------
  // NOTE: the rolling 24h / 30d withdrawal caps are ENTITLEMENT values, not
  // settings. The free baseline is `premium_free_daily_withdraw_limit_cents`
  // (daily) and FREE_ENTITLEMENTS.monthlyWithdrawLimitCents (monthly), and a
  // plan raises them per subscriber. `daily_withdrawal_limit_cents` and
  // `monthly_withdrawal_limit_cents` used to live here but had no reader left,
  // so an operator could "raise the cap" in the panel and change nothing.
  MANUAL_REVIEW_THRESHOLD_CENTS: 'manual_review_threshold_cents',
  MAX_PENDING_WITHDRAWALS: 'max_pending_withdrawals',
  MAX_REFERRALS_PER_DAY: 'max_referrals_per_day',
  MIN_ACCOUNT_AGE_MINUTES_FOR_EAR: 'min_account_age_minutes_for_ear',

  // ---- Budget alerts (item 25) ------------------------------------------
  /// Percentages of a campaign's budget that each fire a BUDGET_LOW notice,
  /// highest first. Each fires once per campaign.
  BUDGET_ALERT_THRESHOLDS: 'budget_alert_thresholds',

  // ---- Email channel ----------------------------------------------------
  /// Master switch. When false the mailer is a no-op and logs instead, so a
  /// deployment with no mail credentials still behaves correctly.
  EMAIL_ENABLED: 'email_enabled',
  EMAIL_FROM: 'email_from',
  EMAIL_REPLY_TO: 'email_reply_to',

  // ---- Security alerts --------------------------------------------------
  SECURITY_ALERTS_ENABLED: 'security_alerts_enabled',

  // ---- Outbound webhooks ------------------------------------------------
  /// Master switch for the whole outbound-webhook feature and its retention
  /// sweep. Off means no fan-out at all (e.g. an incident-hold on egress).
  WEBHOOKS_ENABLED: 'webhooks_enabled',
  WEBHOOK_MAX_ATTEMPTS: 'webhook_max_attempts',
  /// Consecutive failures after which an endpoint is disabled, so a dead URL
  /// does not consume a worker slot forever.
  WEBHOOK_DISABLE_AFTER_FAILURES: 'webhook_disable_after_failures',

  // ---- Channel health ---------------------------------------------------
  /// How often the health sweep re-scores every channel.
  CHANNEL_HEALTH_REFRESH_MINUTES: 'channel_health_refresh_minutes',
  /// A channel scoring below this is not planned for delivery.
  CHANNEL_HEALTH_MIN_FOR_DELIVERY: 'channel_health_min_for_delivery',

  // ---- Invoices ---------------------------------------------------------
  INVOICE_ENABLED: 'invoice_enabled',
  INVOICE_NUMBER_PREFIX: 'invoice_number_prefix',

  // ---- CPC reconciliation ----------------------------------------------
  // There is deliberately NO setting here for "clicks only, no up-front
  // charge". The publisher is paid from the up-front charge at publish time, so
  // a CPC post with no floor would publish for free and leave the publisher
  // unpaid for a delivered post. The up-front estimate is the floor and clicks
  // above it are trued up — see services/cpcBilling.service.ts.

  // ---- Telegram Stars -----------------------------------------------
  /// How many Stars equal one USD. Telegram sets this, not us, and it is the
  /// only bridge between a Stars invoice and our USD-cent ledger.
  /// 80 is taken from the platform's own top-up pricing (100,000 Stars = $1,250).
  /// A setting rather than a constant because Telegram can reprice, and a stale
  /// hardcoded rate would silently mis-value every deposit.
  STARS_PER_USD: 'stars_per_usd',

  // ---- Crypto -------------------------------------------------------
  /// USD cents per whole unit, for assets that are NOT pegged stablecoins.
  /// TON and BTC need this; USDT and USDC are pegged at 100 and never read it.
  /// Zero means "no price known", and an unpriced transfer is HELD rather than
  /// credited at a guess.
  CRYPTO_PRICE_USD_CENTS: 'crypto_price_usd_cents',
} as const;

export const SETTING_DEFAULTS: Record<string, unknown> = {
  [SETTING_KEYS.PLATFORM_FEE_PERCENT]: 20,
  [SETTING_KEYS.STARS_PER_USD]: 80,
  // 0 = unknown. Deliberately not a guess: crediting an unpriced transfer would
  // pay out an invented amount on every deposit.
  [SETTING_KEYS.CRYPTO_PRICE_USD_CENTS]: 0,
  [SETTING_KEYS.MIN_WITHDRAWAL_CENTS]: 500,
  [SETTING_KEYS.MAX_WITHDRAWAL_CENTS]: 100000,
  [SETTING_KEYS.WITHDRAWAL_FEE_CENTS]: 0,
  [SETTING_KEYS.MIN_CAMPAIGN_BUDGET_CENTS]: 500,
  [SETTING_KEYS.MIN_CHANNEL_POST_PRICE_CENTS]: 100,
  [SETTING_KEYS.MAX_CHANNEL_POST_PRICE_CENTS]: 1000000,
  [SETTING_KEYS.EARNING_HOLD_HOURS]: 24,
  [SETTING_KEYS.PUBLISHER_APPROVAL_TIMEOUT_HOURS]: 24,
  [SETTING_KEYS.ADVERTISER_CHANNEL_COOLDOWN_HOURS]: 24,
  [SETTING_KEYS.DUPLICATE_AD_DETECTION_HOURS]: 72,
  [SETTING_KEYS.PLATFORM_MAX_ADS_PER_CHANNEL_PER_DAY]: 6,

  // $1.80 per 1,000 measured views, per the product requirement.
  [SETTING_KEYS.PUBLISHER_CPM_RATE_CENTS]: 180,
  [SETTING_KEYS.PUBLISHER_CPM_ENABLED]: true,
  [SETTING_KEYS.VIEW_SOURCE]: 'none',
  [SETTING_KEYS.PREMIUM_ENABLED]: true,
  [SETTING_KEYS.PREMIUM_FREE_MAX_CHANNELS]: 3,
  [SETTING_KEYS.PREMIUM_FREE_MAX_ACTIVE_CAMPAIGNS]: 2,
  [SETTING_KEYS.PREMIUM_FREE_DAILY_WITHDRAW_LIMIT_CENTS]: 2000,
  // FREE baseline — must stay identical to the historical hard-coded values.
  [SETTING_KEYS.PREMIUM_FREE_MONTHLY_WITHDRAW_LIMIT_CENTS]: 50000,
  [SETTING_KEYS.PREMIUM_FREE_MAX_CAMPAIGN_BUDGET_CENTS]: 100000,
  [SETTING_KEYS.PREMIUM_FREE_CHANNEL_COOLDOWN_HOURS]: 24,
  [SETTING_KEYS.PREMIUM_FREE_MAX_CAMPAIGNS_PER_HOUR]: 2,
  [SETTING_KEYS.SUPPORT_USERNAME]: 'Botflowsapport',

  // $10 -> ~30,300 reach midpoint, displayed as a 25,151 - 40,000 band,
  // which is the 25k-40k range the product owner specified.
  [SETTING_KEYS.ADVERTISER_CPM_CENTS]: 33,
  [SETTING_KEYS.REACH_FLOOR_PERCENT]: 83,
  [SETTING_KEYS.REACH_CEIL_PERCENT]: 132,
  [SETTING_KEYS.REACH_BASIS]: 'subscribers',
  [SETTING_KEYS.MIN_ADVERTISER_BUDGET_CENTS]: 1000,

  // 40% paid advertiser creatives, 60% BotFlow's own promotions.
  [SETTING_KEYS.PAID_AD_SHARE_PERCENT]: 40,
  [SETTING_KEYS.HOUSE_AD_SHARE_PERCENT]: 60,
  [SETTING_KEYS.HOUSE_AD_PUBLISHER_SHARE_PERCENT]: 100,

  [SETTING_KEYS.MIN_SUBSCRIBERS_FOR_MONETIZATION]: 500,
  [SETTING_KEYS.BELOW_THRESHOLD_RECEIVES_POSTS]: false,
  [SETTING_KEYS.HOUSE_AD_LANGUAGE]: 'en',
  [SETTING_KEYS.HOUSE_POST_IDLE_HOURS]: 12,
  [SETTING_KEYS.HOUSE_POST_PAYOUT_CAP_CENTS]: 1000,
  [SETTING_KEYS.REFERRAL_REWARD_CENTS]: 100,
  [SETTING_KEYS.AUTO_APPROVE_CAMPAIGNS]: false,
  [SETTING_KEYS.AUTO_APPROVE_CHANNELS]: false,
  [SETTING_KEYS.MAINTENANCE_MODE]: false,
  [SETTING_KEYS.MAINTENANCE_MESSAGE]: 'BotFlow Ads is temporarily under maintenance.',
  [SETTING_KEYS.MIN_WITHDRAWAL_METHODS]: ['crypto'],
  [SETTING_KEYS.ALLOWED_DEPOSIT_METHODS]: ['crypto', 'telegram_stars'],
  [SETTING_KEYS.MAX_CLICKS_PER_USER_PER_MINUTE]: 20,

  // Payout limits & referral guardrails (code-level fallbacks).
  [SETTING_KEYS.MANUAL_REVIEW_THRESHOLD_CENTS]: 2000,
  [SETTING_KEYS.MAX_PENDING_WITHDRAWALS]: 2,
  [SETTING_KEYS.MAX_REFERRALS_PER_DAY]: 20,
  [SETTING_KEYS.MIN_ACCOUNT_AGE_MINUTES_FOR_EAR]: 1440,

  // Warn at 50 / 25 / 10 / 5 percent of budget consumed, descending.
  [SETTING_KEYS.BUDGET_ALERT_THRESHOLDS]: [50, 25, 10, 5],

  // Email is off until credentials are configured — no half-configured sender.
  [SETTING_KEYS.EMAIL_ENABLED]: false,
  [SETTING_KEYS.EMAIL_FROM]: 'BotFlow Ads <no-reply@botflow-ads.local>',
  [SETTING_KEYS.EMAIL_REPLY_TO]: null,

  [SETTING_KEYS.SECURITY_ALERTS_ENABLED]: true,

  [SETTING_KEYS.WEBHOOKS_ENABLED]: true,
  [SETTING_KEYS.WEBHOOK_MAX_ATTEMPTS]: 5,
  [SETTING_KEYS.WEBHOOK_DISABLE_AFTER_FAILURES]: 20,

  [SETTING_KEYS.CHANNEL_HEALTH_REFRESH_MINUTES]: 60,
  [SETTING_KEYS.CHANNEL_HEALTH_MIN_FOR_DELIVERY]: 40,

  [SETTING_KEYS.INVOICE_ENABLED]: true,
  [SETTING_KEYS.INVOICE_NUMBER_PREFIX]: 'BFA',
};

/** Error codes returned to clients. */
export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  INVALID_TELEGRAM_AUTH: 'INVALID_TELEGRAM_AUTH',
  BOT_PERMISSION_MISSING: 'BOT_PERMISSION_MISSING',
  CHANNEL_NOT_ELIGIBLE: 'CHANNEL_NOT_ELIGIBLE',
  MAINTENANCE: 'MAINTENANCE',
  /** The database is missing a table/column this release expects. */
  SCHEMA_OUT_OF_DATE: 'SCHEMA_OUT_OF_DATE',
  PAYMENT_DUPLICATE: 'PAYMENT_DUPLICATE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/** Weights used by the fraud scoring model. */
export const FRAUD_SCORE = {
  DUPLICATE_CLICK: 20,
  SELF_CLICK: 100,
  CLICK_FLOOD: 60,
  ABNORMAL_CTR: 40,
  REFERRAL_ABUSE: 70,
  MULTI_ACCOUNT: 80,
  SUSPICIOUS_ACCOUNT: 50,
} as const;

export const FRAUD_BLOCK_THRESHOLD = 100;
export const FRAUD_REVIEW_THRESHOLD = 50;

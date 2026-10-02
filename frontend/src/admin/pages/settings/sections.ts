/**
 * Settings sub-page sections (spec §53–60).
 *
 * The ten named sections below are a DISJOINT PARTITION of the real setting
 * keys, plus a trailing "Other" catch-all. Resolution is FIRST-MATCH-WINS:
 * `findSettingsSection` walks `SETTINGS_SECTIONS` in order and returns the first
 * section whose `match` returns true. Every key therefore lands in exactly ONE
 * section, and a key added to the backend later cannot disappear from the panel
 * silently — it falls through to "Other", which matches everything the named
 * sections did not claim.
 *
 * Each named section owns an explicit list of REAL keys (`keys`), and its
 * `match` predicate is derived from that same list, so the predicate the router
 * filters on can never drift from the owned-keys list the info panel shows.
 *
 * The keys below are the ones `SETTING_DEFAULTS` declares in
 * `backend/src/config/constants.ts`, which is the map `getAllSettings()` merges
 * the DB rows over — i.e. the exact key universe `GET /api/admin/settings`
 * returns.
 *
 * This module does NOT import that backend file. The first draft of this file did,
 * and it was wrong: this is browser code, and reaching across packages into
 * `backend/` would drag server modules into the client bundle. The keys are
 * therefore transcribed here, and the guard against drift is one-directional and
 * deliberate:
 *
 *  - at RUNTIME the list is not authoritative at all. The page renders whatever
 *    `GET /api/admin/settings` returns and routes each key to the first section
 *    whose predicate matches, so a key added on the server appears immediately
 *    under "Other" even if nobody updates this file;
 *  - at TEST time `frontend/src/test/settingsSections.test.ts` imports
 *    `SETTING_DEFAULTS` directly (test-only, never bundled) and fails if these
 *    lists stop covering the real key set.
 */
import type { IconName } from '../../../components/ui/icons';

export interface SettingsSection {
  /** URL slug, e.g. "withdrawals". Unique across the list. */
  slug: string;
  /** Human label, e.g. "Withdrawals". */
  label: string;
  /** One-line explanation of what this section controls. */
  description: string;
  /**
   * The real setting keys this section owns. Empty for the "Other" catch-all,
   * whose membership is defined by exclusion rather than enumeration.
   */
  keys: readonly string[];
  /** True when `key` belongs to this section. First match wins when resolving. */
  match: (key: string) => boolean;
  icon?: IconName;
}

/**
 * Every key this module knows about — the union of the sections' own lists.
 *
 * A function, not a frozen constant, for two reasons: the union must not be
 * evaluated before the section list is initialised, and the runtime filter never
 * needs it anyway (the page renders whatever the API returns and routes each key
 * through the predicates). This exists for the info panel and for tests.
 */
export function knownSettingKeys(): readonly string[] {
  const keys = new Set<string>();
  for (const section of SETTINGS_SECTIONS) for (const key of section.keys) keys.add(key);
  return [...keys].sort();
}

function defineSection(
  slug: string,
  label: string,
  description: string,
  keys: readonly string[],
  icon: IconName,
): SettingsSection {
  return { slug, label, description, icon, keys, match: (key: string) => keys.includes(key) };
}

/* ---- The ten named sections. Keys are transcribed from SETTING_DEFAULTS. ---- */

const GENERAL_KEYS: readonly string[] = [
  'platform_fee_percent',
  'auto_approve_campaigns',
  'auto_approve_channels',
  'max_clicks_per_user_per_minute',
  'manual_review_threshold_cents',
  'min_account_age_minutes_for_ear',
];

const ADVERTISING_KEYS: readonly string[] = [
  'min_campaign_budget_cents',
  'duplicate_ad_detection_hours',
  'platform_max_ads_per_channel_per_day',
  'paid_ad_share_percent',
  'house_ad_share_percent',
  'house_ad_publisher_share_percent',
  'house_ad_language',
  'house_post_idle_hours',
  'house_post_payout_cap_cents',
];

const PUBLISHER_KEYS: readonly string[] = [
  'min_channel_post_price_cents',
  'max_channel_post_price_cents',
  'earning_hold_hours',
  'publisher_approval_timeout_hours',
  'publisher_cpm_rate_cents',
  'publisher_cpm_enabled',
  'view_source',
  'min_subscribers_for_monetization',
  'below_threshold_receives_posts',
  'channel_health_refresh_minutes',
  'channel_health_min_for_delivery',
];

const ADVERTISER_KEYS: readonly string[] = [
  'advertiser_channel_cooldown_hours',
  'advertiser_cpm_cents',
  'reach_floor_percent',
  'reach_ceil_percent',
  'reach_basis',
  'min_advertiser_budget_cents',
];

const PAYMENTS_KEYS: readonly string[] = [
  'crypto_price_usd_cents',
  'premium_enabled',
  'premium_free_max_channels',
  'premium_free_max_active_campaigns',
  'premium_free_max_campaign_budget_cents',
  'premium_free_channel_cooldown_hours',
  'premium_free_max_campaigns_per_hour',
  'allowed_deposit_methods',
  'invoice_enabled',
  'invoice_number_prefix',
];

const WITHDRAWALS_KEYS: readonly string[] = [
  'min_withdrawal_cents',
  'max_withdrawal_cents',
  'withdrawal_fee_cents',
  'premium_free_daily_withdraw_limit_cents',
  'premium_free_monthly_withdraw_limit_cents',
  'allowed_withdrawal_methods',
  'max_pending_withdrawals',
];

const REFERRALS_KEYS: readonly string[] = ['referral_reward_cents', 'max_referrals_per_day'];

const NOTIFICATIONS_KEYS: readonly string[] = [
  'email_enabled',
  'email_from',
  'email_reply_to',
  'security_alerts_enabled',
  'budget_alert_thresholds',
  'webhooks_enabled',
  'webhook_max_attempts',
  'webhook_disable_after_failures',
];

const TELEGRAM_KEYS: readonly string[] = ['stars_per_usd', 'support_username'];

const MAINTENANCE_KEYS: readonly string[] = ['maintenance_mode', 'maintenance_message'];

const NAMED_SECTIONS: SettingsSection[] = [
  defineSection(
    'general',
    'General',
    'Platform-wide rules: the platform fee, the auto-approval switches, and the anti-abuse limits that apply to every account.',
    GENERAL_KEYS,
    'settings',
  ),
  defineSection(
    'advertising',
    'Advertising',
    'How campaign ad slots are filled — the paid/house split, house-post cadence and caps, duplicate detection, and the per-channel ad limit.',
    ADVERTISING_KEYS,
    'megaphone',
  ),
  defineSection(
    'publisher',
    'Publisher',
    'What channel owners can charge and earn — post-price bounds, the CPM payout rate, view measurement, monetization eligibility, and channel-health thresholds.',
    PUBLISHER_KEYS,
    'channel',
  ),
  defineSection(
    'advertiser',
    'Advertiser',
    'How an advertiser budget converts to estimated reach — the advertiser CPM, the reach band, what reach is measured in, and the per-channel cooldown.',
    ADVERTISER_KEYS,
    'target',
  ),
  defineSection(
    'payments',
    'Payments',
    'Money coming in and the premium tier it unlocks — deposit methods, Stars and crypto conversion, the free-plan baseline, and invoices.',
    PAYMENTS_KEYS,
    'dollar',
  ),
  defineSection(
    'withdrawals',
    'Withdrawals',
    'Money going out — the withdrawal bounds and fee, the methods that are allowed, the pending-withdrawal cap, and the free-plan withdrawal limits.',
    WITHDRAWALS_KEYS,
    'wallet',
  ),
  defineSection(
    'referrals',
    'Referrals',
    'The referral reward and the daily guardrail that stops referral farming.',
    REFERRALS_KEYS,
    'user',
  ),
  defineSection(
    'notifications',
    'Notifications',
    'Everything that leaves the platform as a message — the email sender, security and budget alerts, and outbound webhooks.',
    NOTIFICATIONS_KEYS,
    'bell',
  ),
  defineSection(
    'telegram',
    'Telegram',
    'The bot-facing surface — the support handle shown to users and the Telegram Stars to USD conversion rate.',
    TELEGRAM_KEYS,
    'send',
  ),
  defineSection(
    'maintenance',
    'Maintenance',
    'The kill switch and the message shown to users while the platform is under maintenance.',
    MAINTENANCE_KEYS,
    'alert',
  ),
];

/**
 * The full section list, in first-match-wins order. "Other" is always LAST: it
 * matches only keys no named section claimed, so it is both a guaranteed
 * catch-all and a no-op for the current backend key set.
 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  ...NAMED_SECTIONS,
  {
    slug: 'other',
    label: 'Other',
    description:
      'Catch-all for any setting key no named section claims, such as a key added to the backend after this module shipped. Nothing should normally land here — every current backend key is owned by a named section.',
    keys: [],
    icon: 'grid',
    match: (key: string) => !NAMED_SECTIONS.some((s) => s.match(key)),
  },
];

/** Resolve a `:section` slug to its section, or `undefined` for an unknown one. */
export function findSettingsSection(slug: string | undefined): SettingsSection | undefined {
  if (!slug) return undefined;
  return SETTINGS_SECTIONS.find((s) => s.slug === slug);
}

export { QUEUE_NAMES } from '@botflow/shared';

/** Job names inside each queue. */
export const JOB = {
  // delivery
  PUBLISH_AD: 'publish-ad',
  RETRY_DELIVERY: 'retry-delivery',

  // scheduler
  SWEEP_DUE_JOBS: 'sweep-due-jobs',
  START_SCHEDULED_CAMPAIGNS: 'start-scheduled-campaigns',
  EXPIRE_CAMPAIGNS: 'expire-campaigns',
  EXPIRE_STALE_APPROVALS: 'expire-stale-approvals',
  EXPIRE_SUBSCRIPTIONS: 'expire-subscriptions',
  /// Fills any channel that has gone quiet with one of BotFlow's own promotions,
  /// so posting never stops when there is no paid inventory.
  FILL_HOUSE_SLOTS: 'fill-house-slots',

  // permission
  CHECK_CHANNEL_PERMISSIONS: 'check-channel-permissions',
  CHECK_SINGLE_CHANNEL: 'check-single-channel',

  // stats
  REFRESH_CHANNEL_STATS: 'refresh-channel-stats',
  SYNC_POST_VIEWS: 'sync-post-views',
  /// Re-scores every channel. Health gates delivery, so a stale score either
  /// sells an advertiser a broken channel or starves a healthy one.
  REFRESH_CHANNEL_HEALTH: 'refresh-channel-health',

  // payout
  RELEASE_MATURED_EARNINGS: 'release-matured-earnings',
  SETTLE_PLATFORM_REVENUE: 'settle-platform-revenue',
  /// Bills CPC campaigns on the valid clicks they have actually accumulated.
  SETTLE_CPC_BILLING: 'settle-cpc-billing',
  /// Pays referral rewards whose conditions have since been met (account aged,
  /// first deposit verified). A sweep, not an event: safe to run repeatedly.
  SETTLE_REFERRALS: 'settle-referrals',

  // withdrawal
  PROCESS_WITHDRAWAL: 'process-withdrawal',

  // fraud
  SCAN_CLICK_PATTERNS: 'scan-click-patterns',
  RECALCULATE_USER_RISK: 'recalculate-user-risk',

  // notification
  SEND_TELEGRAM_NOTIFICATION: 'send-telegram-notification',
  BROADCAST_ADMIN_ALERT: 'broadcast-admin-alert',
  /// One admin broadcast to USERS (spec §52). Carries the resolved recipient
  /// list; the notification worker fans it out per user via
  /// `createBulkNotifications` — the same queue and per-user path as any other
  /// notification, so no second queue is introduced.
  BROADCAST: 'send-broadcast',
  /// Email is a separate job from the Telegram push: one can be configured
  /// without the other, and a mail provider outage must not block a chat message.
  SEND_EMAIL_NOTIFICATION: 'send-email-notification',

  // webhooks (platform -> advertiser)
  /// Deliver one queued webhook (a `WebhookDelivery` row) to its endpoint.
  DELIVER_WEBHOOK: 'deliver-webhook',
  /// Retry every delivery that is due and not yet exhausted.
  DISPATCH_PENDING_WEBHOOKS: 'dispatch-pending-webhooks',

  // crypto
  /// One pass over every configured chain, recording incoming transfers.
  /// Recording only — crediting is a separate, deliberate step, because a chain
  /// cannot say who a transfer belongs to.
  SCAN_CRYPTO_DEPOSITS: 'scan-crypto-deposits',

  // cleanup
  PURGE_OLD_CLICKS: 'purge-old-clicks',
  PURGE_STALE_JOBS: 'purge-stale-jobs',
  AUDIT_BALANCES: 'audit-balances',
  PURGE_WEBHOOK_DELIVERIES: 'purge-webhook-deliveries',
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

/**
 * The jobs carried by the NOTIFICATION queue, as one explicit list.
 *
 * Shared by the notification processor's regression test: it drives the
 * processor with every member and asserts none falls through to the
 * "unknown notification job" default. A job added here but never wired into the
 * processor therefore fails the suite instead of silently disappearing. It is a
 * separate list (not derived from `JOB`) because `JOB` is a flat catalogue
 * across every queue, not one queue's contract.
 */
export const NOTIFICATION_JOBS = [
  JOB.SEND_TELEGRAM_NOTIFICATION,
  JOB.SEND_EMAIL_NOTIFICATION,
  JOB.BROADCAST_ADMIN_ALERT,
  JOB.BROADCAST,
] as const;

export type NotificationJobName = (typeof NOTIFICATION_JOBS)[number];

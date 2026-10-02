import { deliveryQueue, notificationQueue, permissionQueue, statsQueue, webhookQueue, withdrawalQueue } from './queue';
import { JOB } from './names';
import { logger } from '../config/logger';

/**
 * Typed enqueue helpers.
 *
 * Every producer uses a deterministic `jobId` so that re-running the caller
 * (e.g. an admin hitting "retry" twice) does not create duplicate work.
 */

export interface PublishAdJob {
  deliveryJobId: string;
}

export interface NotifyJob {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /**
   * Broadcast delivery tracking (spec §52). OPTIONAL and additive: ordinary
   * producers never set these, so the payload they enqueue is unchanged and the
   * worker's tracking branch (keyed on their presence) is never entered.
   */
  broadcastJobId?: string;
  broadcastRecipientId?: string;
}

/* ------------------------------------------------------------------
 *  Delivery
 * ------------------------------------------------------------------ */

/** Queue a sponsored post for publishing. Uses `delay` for future schedules. */
export async function enqueuePublishAd(
  deliveryJobId: string,
  options: { delayMs?: number; jobIdSuffix?: string } = {},
): Promise<string | null> {
  const jobId = `publish:${deliveryJobId}${options.jobIdSuffix ? `:${options.jobIdSuffix}` : ''}`;

  try {
    const job = await deliveryQueue.add(
      JOB.PUBLISH_AD,
      { deliveryJobId } satisfies PublishAdJob,
      {
        jobId,
        delay: Math.max(0, options.delayMs ?? 0),
      },
    );
    return job.id ?? null;
  } catch (err) {
    logger.error({ err, deliveryJobId }, 'failed to enqueue publish job');
    return null;
  }
}

export async function enqueueRetryDelivery(deliveryJobId: string, delayMs: number): Promise<void> {
  await deliveryQueue.add(
    JOB.RETRY_DELIVERY,
    { deliveryJobId } satisfies PublishAdJob,
    { jobId: `retry:${deliveryJobId}:${Date.now()}`, delay: delayMs },
  );
}

export async function cancelDeliveryJob(queueJobId: string): Promise<void> {
  const job = await deliveryQueue.getJob(queueJobId);
  if (!job) return;
  const state = await job.getState();
  if (state === 'delayed' || state === 'waiting') await job.remove();
}

/* ------------------------------------------------------------------
 *  Permissions & stats
 * ------------------------------------------------------------------ */

export async function enqueueChannelPermissionCheck(channelId: string): Promise<void> {
  await permissionQueue.add(
    JOB.CHECK_SINGLE_CHANNEL,
    { channelId },
    { jobId: `perm:${channelId}:${Math.floor(Date.now() / 300_000)}` },
  );
}

export async function enqueueChannelStatsRefresh(channelId: string): Promise<void> {
  await statsQueue.add(
    JOB.REFRESH_CHANNEL_STATS,
    { channelId },
    { jobId: `stats:${channelId}:${Math.floor(Date.now() / 300_000)}` },
  );
}

/* ------------------------------------------------------------------
 *  Withdrawals
 * ------------------------------------------------------------------ */

export async function enqueueWithdrawalProcessing(withdrawalId: string): Promise<void> {
  await withdrawalQueue.add(JOB.PROCESS_WITHDRAWAL, { withdrawalId }, { jobId: `wd:${withdrawalId}` });
}

/* ------------------------------------------------------------------
 *  Notifications
 * ------------------------------------------------------------------ */

/**
 * Queue an in-app + Telegram notification.
 * Notification delivery is best-effort: it must never block or fail the
 * business operation that triggered it.
 */
export async function enqueueNotification(payload: NotifyJob, delayMs = 0): Promise<void> {
  try {
    await notificationQueue.add(JOB.SEND_TELEGRAM_NOTIFICATION, payload, {
      jobId: `notify:${payload.userId}:${payload.type}:${Date.now()}`,
      delay: delayMs,
      attempts: 2,
    });
  } catch (err) {
    logger.warn({ err, userId: payload.userId, type: payload.type }, 'failed to enqueue notification');
  }
}

/**
 * One admin broadcast to many USERS (spec §52).
 *
 * Rides the existing NOTIFICATION queue — it is the same per-user delivery path
 * the `send-telegram-notification` job uses, so no second queue is introduced.
 * The payload carries the resolved recipient list so the audience is frozen at
 * confirm time.
 *
 * Unlike `enqueueNotification` (best-effort, never throws), this RETURNS the job
 * id and THROWS on failure: an operator who pressed "send" must never be told a
 * broadcast was enqueued when the queue rejected it.
 */
export interface BroadcastJob {
  title: string;
  body: string;
  audience: string;
  userIds: string[];
  /**
   * The `BroadcastJob` row these recipients belong to, plus the
   * `{ userId, recipientId }` mapping. Present for a tracked broadcast; the
   * worker uses it to attribute each send's outcome back to its recipient row.
   */
  broadcastJobId?: string;
  recipients?: { userId: string; recipientId: string }[];
}

export async function enqueueBroadcast(payload: BroadcastJob): Promise<string> {
  const job = await notificationQueue.add(JOB.BROADCAST, payload, {
    // A broadcast is an operator action, not a recurring event: a time-scoped id
    // lets two deliberate sends of the same text both go out.
    jobId: `broadcast:${Date.now()}`,
    attempts: 2,
  });
  return job.id ?? `broadcast:${Date.now()}`;
}

/* ------------------------------------------------------------------
 *  Email
 * ------------------------------------------------------------------ */

export interface EmailJob {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /// Notification row this email mirrors, when there is one, for the audit trail.
  notificationId?: string;
  userId?: string;
}

/**
 * Queue one email. Best-effort like the Telegram push: a mail provider outage
 * must never fail the business operation that triggered the mail.
 */
export async function enqueueEmail(payload: EmailJob, delayMs = 0): Promise<void> {
  try {
    await notificationQueue.add(JOB.SEND_EMAIL_NOTIFICATION, payload, {
      jobId: `email:${payload.to}:${Date.now()}`,
      delay: delayMs,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    });
  } catch (err) {
    logger.warn({ err, to: payload.to }, 'failed to enqueue email');
  }
}

/* ------------------------------------------------------------------
 *  Outbound webhooks (platform -> advertiser)
 * ------------------------------------------------------------------ */

export interface DeliverWebhookJob {
  deliveryId: string;
}

/**
 * Deliver one `WebhookDelivery` row.
 *
 * `attempt` is part of the job id on purpose. BullMQ ignores an `add()` whose
 * job id already exists — and with `removeOnComplete` set, the previous attempt
 * lingers in the completed set for days. A single stable id would therefore
 * swallow every retry silently. Attempt-scoped ids keep each retry schedulable
 * while still deduplicating a double-queue of the same attempt.
 */
export async function enqueueWebhookDelivery(deliveryId: string, delayMs = 0, attempt = 0): Promise<void> {
  try {
    await webhookQueue.add(JOB.DELIVER_WEBHOOK, { deliveryId } satisfies DeliverWebhookJob, {
      jobId: `webhook:${deliveryId}:${attempt}`,
      delay: Math.max(0, delayMs),
    });
  } catch (err) {
    logger.error({ err, deliveryId }, 'failed to enqueue webhook delivery');
  }
}

/**
 * Fan an advertiser-visible event out to every endpoint that subscribes to it.
 *
 * The single entry point every producer of an advertiser-visible event calls, so
 * no caller has to know which endpoints exist. Never throws: an advertiser's
 * dead endpoint must not fail the business operation that raised the event.
 */
export async function emitWebhookEvent(
  userId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<number> {
  try {
    const { queueWebhookEvent } = await import('../services/webhook.service');
    return await queueWebhookEvent(userId, event, payload);
  } catch (err) {
    logger.error({ err, userId, event }, 'failed to fan out webhook event');
    return 0;
  }
}

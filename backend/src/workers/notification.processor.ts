/**
 * The notification queue's processor, extracted from the worker bootstrap.
 *
 * WHY SEPARATE
 * The worker file opens a Redis connection and constructs a BullMQ `Worker` at
 * import time, so importing it in a unit test would try to reach Redis. The
 * processor is pure orchestration and is the thing worth testing — in
 * particular that a NON-broadcast notification never touches the broadcast
 * tracking tables. Keeping it in its own module lets a DB-free test drive it
 * with the services mocked.
 *
 * It still serves EVERY user notification in the product, not just broadcasts.
 */
import type { Processor } from 'bullmq';
import { childLogger } from '../config/logger';
import { JOB } from '../queues/names';
import {
  alertAdmins,
  createBulkNotifications,
  deliverBroadcastMessage,
  deliverToTelegram,
} from '../services/notification.service';
import {
  markBroadcastRunning,
  recomputeBroadcastJob,
  recordBroadcastOutcome,
} from '../services/broadcast.service';
import { sendMail } from '../utils/mailer';

/** JOB.SEND_TELEGRAM_NOTIFICATION payload (see producers.ts NotifyJob). */
export interface TelegramNotificationJobData {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Broadcast tracking ids — present only on a broadcast fan-out. */
  broadcastJobId?: string;
  broadcastRecipientId?: string;
}

/** JOB.BROADCAST_ADMIN_ALERT payload. */
export interface BroadcastAdminAlertJobData {
  text: string;
}

/** JOB.SEND_EMAIL_NOTIFICATION payload (see producers.ts EmailJob). */
export interface EmailNotificationJobData {
  to: string;
  subject: string;
  html: string;
  text?: string;
  notificationId?: string;
  userId?: string;
}

/** JOB.BROADCAST payload. */
export interface BroadcastJobData {
  title: string;
  body: string;
  audience: string;
  userIds: string[];
  /** The BroadcastJob row, when this is a tracked broadcast. */
  broadcastJobId?: string;
  /** Per-recipient row ids, parallel to `userIds`. */
  recipients?: { userId: string; recipientId: string }[];
}

/** Union of everything that can land in the notification queue. */
export interface NotificationJobData {
  userId?: string;
  type?: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  text?: string;
  to?: string;
  subject?: string;
  html?: string;
  notificationId?: string;
  audience?: string;
  userIds?: string[];
  /**
   * Broadcast delivery tracking — OPTIONAL. Present only on notifications the
   * broadcast fan-out produced; its presence is what turns the recording branch
   * on. Ordinary notifications never carry it, so they behave exactly as before.
   */
  broadcastJobId?: string;
  broadcastRecipientId?: string;
}

const log = childLogger('notification-worker');

/**
 * NOTIFICATION WORKER — pushes in-app notifications to Telegram and
 * broadcasts admin alerts. High concurrency: a Telegram hiccup must not
 * queue up the whole product behind one slow chat.
 */
export const processor: Processor<NotificationJobData> = async (job) => {
  try {
    switch (job.name) {
      case JOB.SEND_TELEGRAM_NOTIFICATION: {
        const { userId, type, title, body, data, broadcastJobId, broadcastRecipientId } = job.data;
        if (!userId || !type || !title || !body) {
          throw new Error('send-telegram-notification job payload is incomplete');
        }

        // Broadcast tracking is OPT-IN: it is entered only when the payload
        // carries a recipient id. Every ordinary notification has neither id,
        // so it falls through to the unchanged path below and the tracking code
        // is not reached at all.
        if (broadcastJobId && broadcastRecipientId) {
          const outcome = await deliverBroadcastMessage({ userId, type, title, body, data });

          // Best-effort by contract: `recordBroadcastOutcome` swallows its own
          // failures so a tracking write can never fail the user's delivery.
          await recordBroadcastOutcome({
            jobId: broadcastJobId,
            recipientId: broadcastRecipientId,
            status: outcome.status,
            telegramMessageId: outcome.telegramMessageId,
            error: outcome.error,
          });

          log.info(
            { jobId: job.id, userId, status: outcome.status },
            'tracked broadcast delivery attempt',
          );

          // A transient failure is handed back to BullMQ (the notification job
          // is configured with retries) so the next attempt can still succeed.
          // A SKIPPED recipient is done — retrying an unreachable chat is pointless.
          if (outcome.status === 'FAILED') {
            throw new Error(`broadcast delivery failed: ${outcome.error ?? 'unknown error'}`);
          }
          return;
        }

        const delivered = await deliverToTelegram({ userId, type, title, body, data });
        log.info({ jobId: job.id, userId, type, delivered }, 'telegram notification attempt');
        return;
      }
      case JOB.SEND_EMAIL_NOTIFICATION: {
        const { to, subject, html, text, notificationId, userId } = job.data as EmailNotificationJobData;
        if (!to || !subject || !html) {
          throw new Error('send-email-notification job payload is incomplete');
        }

        // sendMail never throws: every failure mode resolves to
        // { sent: false, reason }. Configuration states ("email disabled",
        // "no transport available") are final — retrying a deployment that
        // has no mail setup is pointless — but a real send failure is handed
        // back to BullMQ, whose attempts/backoff were configured for exactly
        // this job.
        const result = await sendMail({ to, subject, html, text });
        log.info(
          { jobId: job.id, to, userId, notificationId, sent: result.sent, reason: result.reason },
          'email notification attempt',
        );
        if (!result.sent && result.reason !== 'email disabled' && result.reason !== 'no transport available') {
          throw new Error(`email send failed: ${result.reason}`);
        }
        return;
      }
      case JOB.BROADCAST_ADMIN_ALERT: {
        const { text } = job.data as BroadcastAdminAlertJobData;
        if (!text) throw new Error('broadcast-admin-alert job has no text');

        await alertAdmins(text);
        log.info({ jobId: job.id }, 'admin alert broadcast');
        return;
      }
      case JOB.BROADCAST: {
        const { title, body, audience, userIds, recipients, broadcastJobId } = job.data as BroadcastJobData;

        // A tracked broadcast carries the per-recipient mapping. Fall back to
        // the plain `userIds` shape so any older producer still fans out (just
        // without tracking).
        const list: { userId: string; recipientId?: string }[] = Array.isArray(recipients)
          ? recipients
          : (Array.isArray(userIds) ? userIds : []).map((userId) => ({ userId }));

        if (!title || !body || list.length === 0) {
          // A tracked broadcast with nobody in it is not an error — there is
          // simply nothing to send. Close it out rather than leaving a row
          // RUNNING forever.
          if (broadcastJobId) {
            await recomputeBroadcastJob(broadcastJobId).catch((err) =>
              log.error({ err, broadcastJobId }, 'failed to finalise empty broadcast'),
            );
            log.info({ jobId: job.id, broadcastJobId, recipients: 0 }, 'user broadcast had no recipients');
            return;
          }
          throw new Error('send-broadcast job payload is incomplete');
        }

        if (broadcastJobId) {
          await markBroadcastRunning(broadcastJobId).catch((err) =>
            log.warn({ err, broadcastJobId }, 'could not mark broadcast RUNNING'),
          );
        }

        // Fan out to USERS through the SAME per-user path every notification
        // uses (persist the in-app row, then enqueue one Telegram push each).
        // No new delivery mechanism: `createBulkNotifications` is the existing
        // per-user fan-out, and this job simply drives it from the queue.
        await createBulkNotifications(
          list.map((recipient) => ({
            userId: recipient.userId,
            type: 'SYSTEM' as const,
            title,
            body,
            ...(broadcastJobId && recipient.recipientId
              ? { broadcastJobId, broadcastRecipientId: recipient.recipientId }
              : {}),
          })),
        );
        log.info({ jobId: job.id, audience, recipients: list.length }, 'user broadcast fanned out');
        return;
      }
      default:
        throw new Error(`unknown notification job: ${job.name}`);
    }
  } catch (err) {
    log.error({ err, jobId: job.id, jobName: job.name }, 'notification processor failed');
    throw err;
  }
};

import { Worker, type Processor } from 'bullmq';
import { childLogger } from '../config/logger';
import { createQueueConnection } from '../db/redis';
import { JOB, QUEUE_NAMES } from '../queues/names';
import { alertAdmins, deliverToTelegram } from '../services/notification.service';
import { sendMail } from '../utils/mailer';
import { register } from './registry';

/** JOB.SEND_TELEGRAM_NOTIFICATION payload (see producers.ts NotifyJob). */
export interface TelegramNotificationJobData {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
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
}

const log = childLogger('notification-worker');

/**
 * NOTIFICATION WORKER — pushes in-app notifications to Telegram and
 * broadcasts admin alerts. High concurrency: a Telegram hiccup must not
 * queue up the whole product behind one slow chat.
 */
const processor: Processor<NotificationJobData> = async (job) => {
  try {
    switch (job.name) {
      case JOB.SEND_TELEGRAM_NOTIFICATION: {
        const { userId, type, title, body, data } = job.data;
        if (!userId || !type || !title || !body) {
          throw new Error('send-telegram-notification job payload is incomplete');
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
      default:
        throw new Error(`unknown notification job: ${job.name}`);
    }
  } catch (err) {
    log.error({ err, jobId: job.id, jobName: job.name }, 'notification processor failed');
    throw err;
  }
};

const connection = createQueueConnection('botflow-worker-notification');
connection.on('error', (err) => log.error({ err: err.message }, 'worker redis error'));

const worker = new Worker<NotificationJobData>(QUEUE_NAMES.NOTIFICATION, processor, {
  connection,
  concurrency: 10,
  lockDuration: 300_000,
});

register(worker, QUEUE_NAMES.NOTIFICATION);

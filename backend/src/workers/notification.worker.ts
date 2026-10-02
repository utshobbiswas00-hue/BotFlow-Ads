/**
 * Notification worker bootstrap.
 *
 * The processor itself lives in `notification.processor.ts` so it can be unit
 * tested without opening a Redis connection; this file only wires it to BullMQ.
 */
import { Worker } from 'bullmq';
import { childLogger } from '../config/logger';
import { createQueueConnection } from '../db/redis';
import { QUEUE_NAMES } from '../queues/names';
import { processor, type NotificationJobData } from './notification.processor';
import { register } from './registry';

// Kept re-exported for any reader that imported the payload shapes from here.
export type {
  TelegramNotificationJobData,
  BroadcastAdminAlertJobData,
  EmailNotificationJobData,
  BroadcastJobData,
  NotificationJobData,
} from './notification.processor';

const log = childLogger('notification-worker');

const connection = createQueueConnection('botflow-worker-notification');
connection.on('error', (err) => log.error({ err: err.message }, 'worker redis error'));

const worker = new Worker<NotificationJobData>(QUEUE_NAMES.NOTIFICATION, processor, {
  connection,
  concurrency: 10,
  lockDuration: 300_000,
});

register(worker, QUEUE_NAMES.NOTIFICATION);

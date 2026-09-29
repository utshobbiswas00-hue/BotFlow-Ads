import { Worker, type Processor } from 'bullmq';
import { childLogger } from '../config/logger';
import { createQueueConnection } from '../db/redis';
import { JOB, QUEUE_NAMES } from '../queues/names';
import { deliverWebhook, dispatchPendingWebhookDeliveries } from '../services/webhook.service';
import { register } from './registry';

/** JOB.DELIVER_WEBHOOK payload (see producers.ts DeliverWebhookJob). */
export interface DeliverWebhookJobData {
  deliveryId: string;
}

const log = childLogger('webhook-worker');

/**
 * WEBHOOK WORKER — the outbound side of programmatic access.
 *
 * Concurrency is deliberately higher than the delivery worker's: these jobs are
 * HTTP calls to third-party endpoints we do not control, so a slow subscriber
 * must not serialise the queue behind it. `deliverWebhook` itself never throws
 * for a failed request — it records the outcome and schedules the retry — so a
 * subscriber's downtime can never crash the worker.
 */
const processor: Processor<DeliverWebhookJobData> = async (job) => {
  try {
    switch (job.name) {
      case JOB.DELIVER_WEBHOOK: {
        const { deliveryId } = job.data;
        if (!deliveryId) throw new Error('deliver-webhook job has no deliveryId');

        const outcome = await deliverWebhook(deliveryId);
        log.info(
          { jobId: job.id, deliveryId, status: outcome.status, attempts: outcome.attempts },
          'webhook delivery attempt',
        );
        return;
      }
      case JOB.DISPATCH_PENDING_WEBHOOKS: {
        const requeued = await dispatchPendingWebhookDeliveries();
        log.info({ jobId: job.id, requeued }, 'pending webhook deliveries dispatched');
        return;
      }
      default:
        throw new Error(`unknown webhook job: ${job.name}`);
    }
  } catch (err) {
    log.error({ err, jobId: job.id, jobName: job.name }, 'webhook processor failed');
    throw err;
  }
};

const connection = createQueueConnection('botflow-worker-webhook');
connection.on('error', (err) => log.error({ err: err.message }, 'worker redis error'));

const worker = new Worker<DeliverWebhookJobData>(QUEUE_NAMES.WEBHOOK, processor, {
  connection,
  concurrency: 5,
  lockDuration: 300_000,
});

register(worker, QUEUE_NAMES.WEBHOOK);

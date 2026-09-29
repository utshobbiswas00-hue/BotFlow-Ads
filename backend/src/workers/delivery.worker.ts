import { Worker, type Processor } from 'bullmq';
import { childLogger } from '../config/logger';
import { createQueueConnection } from '../db/redis';
import { JOB, QUEUE_NAMES } from '../queues/names';
import { publishDeliveryJob } from '../services/delivery.service';
import { register } from './registry';

/** Payload for JOB.PUBLISH_AD and JOB.RETRY_DELIVERY (see producers.ts). */
export interface DeliveryJobData {
  deliveryJobId: string;
}

const log = childLogger('delivery-worker');

/**
 * AD DELIVERY WORKER — the consumer side of the delivery engine.
 *
 * Publishing is idempotent end-to-end: `publishDeliveryJob` claims the
 * DeliveryJob with a conditional update, so a BullMQ retry or a duplicate
 * job can never publish (or charge) the same post twice.
 */
const processor: Processor<DeliveryJobData> = async (job) => {
  try {
    if (job.name !== JOB.PUBLISH_AD && job.name !== JOB.RETRY_DELIVERY) {
      throw new Error(`unknown delivery job: ${job.name}`);
    }

    const { deliveryJobId } = job.data;
    if (!deliveryJobId) throw new Error(`delivery job ${job.id} has no deliveryJobId`);

    const outcome = await publishDeliveryJob(deliveryJobId);
    log.info(
      { jobId: job.id, deliveryJobId, result: outcome.result, reason: outcome.reason },
      'delivery job processed',
    );
  } catch (err) {
    log.error({ err, jobId: job.id, jobName: job.name }, 'delivery processor failed');
    throw err;
  }
};

const connection = createQueueConnection('botflow-worker-delivery');
connection.on('error', (err) => log.error({ err: err.message }, 'worker redis error'));

const worker = new Worker<DeliveryJobData>(QUEUE_NAMES.DELIVERY, processor, {
  connection,
  concurrency: 5,
  lockDuration: 300_000,
});

register(worker, QUEUE_NAMES.DELIVERY);

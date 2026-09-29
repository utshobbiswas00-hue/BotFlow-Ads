import { Worker, type Processor } from 'bullmq';
import { childLogger } from '../config/logger';
import { createQueueConnection } from '../db/redis';
import { JOB, QUEUE_NAMES } from '../queues/names';
import { recalculateUserRisk, scanClickPatterns } from '../services/fraud.service';
import { register } from './registry';

/** The click-pattern scan has no payload; a risk recalculation targets one user. */
export interface FraudJobData {
  userId?: string;
}

const log = childLogger('fraud-worker');

/**
 * FRAUD WORKER — detects click abuse after the fact and keeps per-user
 * risk scores current. The click flood / duplicate rules also run inline
 * at click time; this worker is the heavier, periodic analysis.
 */
const processor: Processor<FraudJobData> = async (job) => {
  try {
    switch (job.name) {
      case JOB.SCAN_CLICK_PATTERNS: {
        const flagged = await scanClickPatterns();
        log.info({ jobId: job.id, flagged }, 'click-pattern scan finished');
        return;
      }
      case JOB.RECALCULATE_USER_RISK: {
        const { userId } = job.data;
        if (!userId) throw new Error('recalculate-user-risk job has no userId');

        const score = await recalculateUserRisk(userId);
        log.info({ jobId: job.id, userId, score }, 'user risk recalculated');
        return;
      }
      default:
        throw new Error(`unknown fraud job: ${job.name}`);
    }
  } catch (err) {
    log.error({ err, jobId: job.id, jobName: job.name }, 'fraud processor failed');
    throw err;
  }
};

const connection = createQueueConnection('botflow-worker-fraud');
connection.on('error', (err) => log.error({ err: err.message }, 'worker redis error'));

const worker = new Worker<FraudJobData>(QUEUE_NAMES.FRAUD, processor, {
  connection,
  concurrency: 2,
  lockDuration: 300_000,
});

register(worker, QUEUE_NAMES.FRAUD);

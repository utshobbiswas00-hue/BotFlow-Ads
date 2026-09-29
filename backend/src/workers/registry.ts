import type { Worker } from 'bullmq';
import { childLogger } from '../config/logger';

/**
 * Central registry of every BullMQ Worker in this process.
 *
 * Each worker module calls `register(worker)` when it is imported (the
 * entry point pulls them in with side-effect imports). The entry point
 * then uses `closeAllWorkers()` on SIGTERM/SIGINT so every worker can
 * drain its active jobs before the process exits.
 */

const log = childLogger('worker-registry');

interface TrackedWorker {
  name: string;
  worker: Worker;
}

const workers: TrackedWorker[] = [];

/** Track a worker for shutdown and attach process-wide observability. */
export function register(worker: Worker, name?: string): Worker {
  const queueName = name ?? 'unknown';
  workers.push({ name: queueName, worker });

  worker.on('failed', (job, err) => {
    log.error(
      {
        err: err.message,
        jobId: job?.id,
        name: job?.name,
        attempt: job?.attemptsMade ?? 0,
        queue: queueName,
      },
      'job failed (BullMQ will retry if attempts remain)',
    );
  });

  worker.on('error', (err) => {
    log.error({ err: err.message, queue: queueName }, 'worker error');
  });

  return worker;
}

/** Read-only snapshot of the registered workers. */
export function registeredWorkers(): Worker[] {
  return workers.map((w) => w.worker);
}

/**
 * Gracefully stop every registered worker.
 *
 * BullMQ stops picking up new jobs once `close()` is called; in-flight
 * jobs finish (a hard kill would instead leave them to the lock timeout).
 */
export async function closeAllWorkers(): Promise<void> {
  log.info({ count: workers.length }, 'closing all workers');
  await Promise.allSettled(workers.map(({ worker }) => worker.close()));
  workers.length = 0;
}

import { Worker, type Processor } from 'bullmq';
import { childLogger } from '../config/logger';
import { createQueueConnection } from '../db/redis';
import { JOB, QUEUE_NAMES } from '../queues/names';
import { refreshAllChannelStats, refreshChannelStats } from '../services/channelStats.service';
import { refreshAllChannelHealth } from '../services/channelHealth.service';
import { syncPostViews } from '../services/tracking.service';
import { register } from './registry';

/**
 * channelId present → refresh that channel's stats only; absent → refresh all.
 * `limit` (health job) caps how many channels one sweep re-scores.
 */
export interface ChannelStatsJobData {
  channelId?: string;
  limit?: number;
}

const log = childLogger('stats-worker');

/**
 * STATS WORKER — keeps channel performance numbers fresh for the
 * marketplace and CPM/CPC pricing, and pulls live view counts for
 * published sponsored posts from Telegram.
 */
const processor: Processor<ChannelStatsJobData> = async (job) => {
  try {
    switch (job.name) {
      case JOB.REFRESH_CHANNEL_STATS: {
        const { channelId } = job.data;
        if (channelId) {
          await refreshChannelStats(channelId);
          log.info({ jobId: job.id, channelId }, 'channel stats refreshed');
        } else {
          const refreshed = await refreshAllChannelStats();
          log.info({ jobId: job.id, refreshed }, 'all channel stats refreshed');
        }
        return;
      }
      case JOB.SYNC_POST_VIEWS: {
        const synced = await syncPostViews();
        log.info({ jobId: job.id, synced }, 'post views synced');
        return;
      }
      case JOB.REFRESH_CHANNEL_HEALTH: {
        const { limit } = job.data;
        const refreshed = await refreshAllChannelHealth(limit);
        log.info({ jobId: job.id, refreshed, limit: limit ?? null }, 'channel health refreshed');
        return;
      }
      default:
        throw new Error(`unknown stats job: ${job.name}`);
    }
  } catch (err) {
    log.error({ err, jobId: job.id, jobName: job.name }, 'stats processor failed');
    throw err;
  }
};

const connection = createQueueConnection('botflow-worker-stats');
connection.on('error', (err) => log.error({ err: err.message }, 'worker redis error'));

const worker = new Worker<ChannelStatsJobData>(QUEUE_NAMES.STATS, processor, {
  connection,
  concurrency: 2,
  lockDuration: 300_000,
});

register(worker, QUEUE_NAMES.STATS);

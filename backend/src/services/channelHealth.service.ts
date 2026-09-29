import type { ChannelHealthStatus } from '@prisma/client';
import { prisma } from '../db/prisma';
import { NotFoundError } from '../utils/errors';
import { childLogger } from '../config/logger';

const log = childLogger('channel-health');

/* ------------------------------------------------------------------ */
/*  Thresholds — DeliveryJobStatus values are plain strings:           */
/*  PENDING | SCHEDULED | LOCKED | PROCESSING | COMPLETED | FAILED |   */
/*  RETRYING | CANCELLED | AWAITING_APPROVAL                           */
/* ------------------------------------------------------------------ */

const JOB_FAILED = 'FAILED';
const RECENT_JOBS_WINDOW = 20;
const MAX_CONSECUTIVE_FAILURES = 3;
const FAILURE_RATE_THRESHOLD = 0.7;
const MAX_UNRESOLVED_VIOLATIONS = 1;
const HEALTHY_FLOOR = 70;
const HEALTHY_PENALTY_PER_FAILURE = 5;
const AD_FREQUENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A single health sweep must be bounded: every channel costs one query per
 * factor, and an unbounded run can exceed the worker's 300 s lock and be
 * re-run, duplicating work. Ordering by `lastPermissionCheck` (oldest first)
 * makes the cap a fair rotation rather than a fixed subset.
 */
const DEFAULT_HEALTH_SWEEP_LIMIT = 200;
const MAX_HEALTH_SWEEP_LIMIT = 1000;

export interface ChannelHealth {
  healthStatus: ChannelHealthStatus;
  score: number;
  factors: {
    botIsAdmin: boolean;
    canPost: boolean;
    consecutiveFailures: number;
    failureRate: number;
    recentDeliveries: number;
    adFrequencyLast24h: number;
    violations: number;
  };
  explanation: string;
}

/**
 * Compute (but do not persist) the health of a channel from real data only:
 * the permission snapshot, the last 20 delivery jobs, unresolved fraud
 * events / reports tied to the channel, and posts published in the last 24h.
 *
 * Rules are evaluated in order and the FIRST match wins — a later rule can
 * never upgrade an earlier downgrade.
 */
export async function computeChannelHealth(channelId: string): Promise<ChannelHealth | null> {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) return null;

  const since24h = new Date(Date.now() - AD_FREQUENCY_WINDOW_MS);

  const [jobs, fraudEvents, openReports, recentPosts] = await Promise.all([
    prisma.deliveryJob.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: RECENT_JOBS_WINDOW,
      select: { status: true },
    }),
    prisma.fraudEvent.count({
      where: { entityType: 'CHANNEL', entityId: channelId, resolved: false },
    }),
    prisma.report.count({
      where: { status: { in: ['OPEN', 'REVIEWING'] }, adPost: { channelId } },
    }),
    prisma.adPost.count({
      where: { channelId, publishedAt: { gte: since24h } },
    }),
  ]);

  const recentDeliveries = jobs.length;
  let consecutiveFailures = 0;
  for (const job of jobs) {
    if (job.status === JOB_FAILED) consecutiveFailures += 1;
    else break;
  }
  const failures = jobs.filter((job) => job.status === JOB_FAILED).length;
  const failureRate = recentDeliveries > 0 ? failures / recentDeliveries : 0;
  const violations = fraudEvents + openReports;
  const adFrequencyLast24h = recentPosts;

  let healthStatus: ChannelHealthStatus;
  let score: number;
  let explanation: string;

  if (channel.status === 'SUSPENDED') {
    healthStatus = 'SUSPENDED';
    score = 0;
    explanation =
      'This channel is suspended, so no ads can be delivered until the suspension is lifted.';
  } else if (!channel.botIsAdmin || !channel.canPostMessages) {
    healthStatus = 'ATTENTION_REQUIRED';
    score = 25;
    explanation = !channel.botIsAdmin
      ? 'The bot is not an administrator of this channel, so no posts can be delivered.'
      : 'The bot does not have permission to post messages in this channel, so no posts can be delivered.';
  } else if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
    healthStatus = 'ATTENTION_REQUIRED';
    score = 40;
    explanation = `The last ${consecutiveFailures} delivery attempts all failed, so check the bot's access in this channel before expecting more ads.`;
  } else if (failureRate > FAILURE_RATE_THRESHOLD) {
    healthStatus = 'RESTRICTED';
    score = 50;
    explanation = `More than 70% of the last ${recentDeliveries} delivery attempts failed, so new ads are restricted until delivery is working again.`;
  } else if (violations > MAX_UNRESOLVED_VIOLATIONS) {
    healthStatus = 'RESTRICTED';
    score = 60;
    explanation = `This channel has ${violations} unresolved fraud or report events, so new ads are restricted until they are reviewed and resolved.`;
  } else {
    healthStatus = 'HEALTHY';
    score = Math.max(HEALTHY_FLOOR, 100 - failures * HEALTHY_PENALTY_PER_FAILURE);
    explanation =
      failures > 0
        ? `This channel is healthy, with a small score deduction for ${failures} recent failed deliver${failures === 1 ? 'y' : 'ies'}.`
        : 'This channel is healthy and eligible for ad delivery.';
  }

  return {
    healthStatus,
    score,
    factors: {
      botIsAdmin: channel.botIsAdmin,
      canPost: channel.canPostMessages,
      consecutiveFailures,
      failureRate: Math.round(failureRate * 10000) / 10000,
      recentDeliveries,
      adFrequencyLast24h,
      violations,
    },
    explanation,
  };
}

/**
 * Compute and persist a single channel's health: status, numeric score and
 * the check timestamp. Returns the new status.
 */
export async function refreshChannelHealth(channelId: string): Promise<ChannelHealthStatus> {
  const health = await computeChannelHealth(channelId);
  if (!health) throw new NotFoundError('Channel');
  await prisma.channel.update({
    where: { id: channelId },
    data: {
      healthStatus: health.healthStatus,
      healthScore: health.score,
      healthCheckedAt: new Date(),
    },
  });
  return health.healthStatus;
}

/**
 * Refresh health for every channel that is live or flagged — status
 * APPROVED / ATTENTION_REQUIRED, or healthStatus ATTENTION_REQUIRED /
 * RESTRICTED (ChannelStatus has no RESTRICTED value, so both fields are
 * unioned). Oldest lastPermissionCheck first (never-checked = most stale).
 *
 * Safe to run repeatedly (a repeatable job does, hourly): every channel is
 * re-scored from current data and its status, score and check timestamp are
 * written, whether or not anything changed. One bad channel never aborts the
 * sweep — it is logged and skipped. Returns how many channels were
 * successfully refreshed.
 */
export async function refreshAllChannelHealth(limit?: number): Promise<number> {
  const take = Math.max(1, Math.min(limit ?? DEFAULT_HEALTH_SWEEP_LIMIT, MAX_HEALTH_SWEEP_LIMIT));

  const channels = await prisma.channel.findMany({
    where: {
      OR: [
        { status: { in: ['APPROVED', 'ATTENTION_REQUIRED'] } },
        { healthStatus: { in: ['ATTENTION_REQUIRED', 'RESTRICTED'] } },
      ],
    },
    orderBy: [{ lastPermissionCheck: 'asc' }, { id: 'asc' }],
    take,
    select: { id: true, healthStatus: true, lastPermissionCheck: true },
  });

  channels.sort(
    (a, b) => (a.lastPermissionCheck?.getTime() ?? 0) - (b.lastPermissionCheck?.getTime() ?? 0),
  );

  const batch = limit !== undefined ? channels.slice(0, limit) : channels;
  let refreshed = 0;

  for (const channel of batch) {
    try {
      const health = await computeChannelHealth(channel.id);
      if (!health) continue; // deleted between select and compute — nothing to do
      await prisma.channel.update({
        where: { id: channel.id },
        data: {
          healthStatus: health.healthStatus,
          healthScore: health.score,
          healthCheckedAt: new Date(),
        },
      });
      refreshed += 1;
    } catch (err) {
      log.warn({ channelId: channel.id, err }, 'channel health refresh failed');
    }
  }

  log.info({ considered: batch.length, refreshed }, 'channel health refresh complete');
  return refreshed;
}

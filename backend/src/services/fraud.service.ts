import type { FraudSeverity, FraudType, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { FRAUD_BLOCK_THRESHOLD, FRAUD_REVIEW_THRESHOLD, FRAUD_SCORE } from '../config/constants';
import { ctrString } from '../utils/format';
import { alertAdmins } from './notification.service';
import { logger } from '../config/logger';

/**
 * Fraud detection & scoring.
 *
 * Scores use the FRAUD_SCORE weights from config/constants.ts. A score at or
 * above FRAUD_REVIEW_THRESHOLD warrants human review; at or above
 * FRAUD_BLOCK_THRESHOLD the actor should be blocked / their earnings held.
 */

export interface ClickRiskInput {
  adId: string;
  ipHash: string;
  telegramUserId?: string | null;
  /** Cumulative stats of the post that received the click. */
  views: number;
  clicks: number;
}

export interface ClickRiskResult {
  score: number;
  reasons: string[];
}

function toBigIntOrNull(value: string | null | undefined): bigint | null {
  if (!value) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map a numeric risk score onto a severity using the block/review thresholds. */
export function severityForScore(score: number): FraudSeverity {
  if (score >= FRAUD_BLOCK_THRESHOLD) return 'CRITICAL';
  if (score >= FRAUD_REVIEW_THRESHOLD) return 'HIGH';
  return 'MEDIUM';
}

/**
 * Score the fraud risk of a single click using the FRAUD_SCORE weights.
 *
 * Signals considered:
 *  - SELF_CLICK        the clicker (by Telegram id) is the campaign's advertiser
 *  - DUPLICATE_CLICK   the same IP clicked the same ad more than once in 24h
 *  - CLICK_FLOOD       the same IP clicked more than MAX_CLICKS_PER_IP_PER_MINUTE in the last MINUTE
 *  - ABNORMAL_CTR      the post's click-through rate exceeds MAX_CTR_THRESHOLD
 *
 * The score is capped at FRAUD_BLOCK_THRESHOLD so `>= threshold` stays the
 * canonical "block" test. Never throws — partial data yields a partial score.
 */
export async function scoreClickRisk(input: ClickRiskInput): Promise<ClickRiskResult> {
  const reasons: string[] = [];
  let score = 0;

  const add = (type: keyof typeof FRAUD_SCORE, reason: string): void => {
    score += FRAUD_SCORE[type];
    reasons.push(reason);
  };

  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // The flood threshold is MAX_CLICKS_PER_IP_PER_MINUTE, so it must be
    // compared against a one-MINUTE window. Counting the last hour against a
    // per-minute limit flagged an ordinary one-per-minute visitor as a flood.
    const minuteAgo = new Date(Date.now() - 60 * 1000);

    const ad = await prisma.ad.findUnique({
      where: { id: input.adId },
      select: { campaign: { select: { advertiserId: true } } },
    });
    const advertiserId = ad?.campaign?.advertiserId ?? null;

    const [dayClicks, minuteClicks, clicker] = await Promise.all([
      prisma.click.count({
        where: { adId: input.adId, ipHash: input.ipHash, createdAt: { gte: dayAgo } },
      }),
      prisma.click.count({
        where: { adId: input.adId, ipHash: input.ipHash, createdAt: { gte: minuteAgo } },
      }),
      (async () => {
        const tgId = toBigIntOrNull(input.telegramUserId);
        if (tgId === null) return null;
        return prisma.user.findFirst({ where: { telegramId: tgId }, select: { id: true } });
      })(),
    ]);

    if (clicker && advertiserId && clicker.id === advertiserId) {
      add('SELF_CLICK', 'Clicker is the campaign advertiser');
    }
    if (dayClicks > 1) {
      add('DUPLICATE_CLICK', `${dayClicks} clicks from the same IP on this ad in the last 24h`);
    }
    if (minuteClicks > env.MAX_CLICKS_PER_IP_PER_MINUTE) {
      add('CLICK_FLOOD', `${minuteClicks} clicks from the same IP on this ad in the last minute`);
    }
    if (input.views > 0 && input.clicks / input.views > env.MAX_CTR_THRESHOLD) {
      add('ABNORMAL_CTR', `Post CTR ${ctrString(input.clicks, input.views)} exceeds the ${env.MAX_CTR_THRESHOLD} threshold`);
    }
  } catch (err) {
    // A scoring failure must not break the caller (e.g. the tracking path).
    logger.error({ err: errMessage(err), adId: input.adId }, 'scoreClickRisk: lookups failed, returning partial score');
  }

  return { score: Math.min(score, FRAUD_BLOCK_THRESHOLD), reasons };
}

/* ------------------------------------------------------------------
 *  Pattern scan (runs from the fraud worker)
 * ------------------------------------------------------------------ */

export interface NewEvent {
  type: FraudType;
  severity: FraudSeverity;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}

/** True when an unresolved event of the same type+entity exists within 24h. */
async function hasUnresolvedEvent(type: FraudType, entityId: string, since: Date): Promise<boolean> {
  const existing = await prisma.fraudEvent.findFirst({
    where: { type, entityId, resolved: false, createdAt: { gte: since } },
    select: { id: true },
  });
  return existing !== null;
}

async function writeEvent(ev: NewEvent): Promise<boolean> {
  try {
    await prisma.fraudEvent.create({
      data: {
        type: ev.type,
        severity: ev.severity,
        entityType: ev.entityType,
        entityId: ev.entityId,
        details: ev.details as Prisma.InputJsonValue,
      },
    });
    return true;
  } catch (err) {
    logger.error({ err: errMessage(err), ...ev }, 'fraud scan: failed to write event');
    return false;
  }
}

/**
 * Record ONE fraud event from a call site outside the pattern scan — for
 * example a referral signup that failed its fraud guard, or a withdrawal the
 * limits flagged for manual review.
 *
 * Deduplicated by default: while an unresolved event of the same type + entity
 * exists within the last 24 hours, a repeat is dropped. That keeps a bot
 * hammering the same endpoint from filling the review queue with duplicates.
 * Callers that genuinely need every occurrence (an audit trail of attempts)
 * can pass `dedupe: false`.
 */
export async function recordFraudEvent(
  input: NewEvent & { dedupe?: boolean },
): Promise<boolean> {
  if (input.dedupe !== false) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (await hasUnresolvedEvent(input.type, input.entityId, dayAgo)) return false;
  }

  return writeEvent({
    type: input.type,
    severity: input.severity,
    entityType: input.entityType,
    entityId: input.entityId,
    details: input.details ?? {},
  });
}

/**
 * Scan recent activity for fraud patterns and record FraudEvent rows.
 *
 *  1. Click floods: (adId, ipHash) groups with more than 10 clicks in the
 *     last hour.
 *  2. Abnormal CTR: ad posts with at least 50 views whose click-through rate
 *     exceeds env.MAX_CTR_THRESHOLD.
 *
 * Duplicate detection: an event is skipped when an unresolved event of the
 * same type + entity already exists within the last 24h. HIGH/CRITICAL
 * events page the admins over Telegram.
 *
 * Returns the number of events created.
 */
export async function scanClickPatterns(): Promise<number> {
  let created = 0;
  const alerts: string[] = [];
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  try {
    // ---- 1. Click floods ------------------------------------------------
    // Ordered by click count (desc) so the take-limit can only cut off
    // groups that are NOT floods; every group above the threshold survives.
    const floodGroups = await prisma.click.groupBy({
      by: ['adId', 'ipHash'],
      where: { ipHash: { not: null }, createdAt: { gte: hourAgo } },
      _count: { _all: true },
      // adId is non-nullable, so its per-group count equals the group size.
      orderBy: { _count: { adId: 'desc' } },
      take: 200,
    });

    for (const g of floodGroups) {
      if (g.ipHash === null) continue;
      const count = g._count._all;
      if (count <= 10) continue;
      const entityId = `${g.adId}:${g.ipHash}`;

      if (await hasUnresolvedEvent('CLICK_FLOOD', entityId, dayAgo)) continue;

      // Duplicates are implied by the flood, so they add their weight too;
      // an extreme flood crosses the block threshold and becomes CRITICAL.
      const score =
        FRAUD_SCORE.CLICK_FLOOD +
        FRAUD_SCORE.DUPLICATE_CLICK +
        (count >= 60 ? FRAUD_SCORE.ABNORMAL_CTR : 0);

      const severity = severityForScore(score);
      if (
        await writeEvent({
          type: 'CLICK_FLOOD',
          severity,
          entityType: 'AD',
          entityId,
          details: { adId: g.adId, ipHash: g.ipHash, clicksInLastHour: count },
        })
      ) {
        created += 1;
        if (severity === 'HIGH' || severity === 'CRITICAL') {
          alerts.push(`${severity} CLICK_FLOOD: ${count} clicks on ad ${g.adId} from one IP in the last hour`);
        }
      }
    }

    // ---- 2. Abnormal CTR -------------------------------------------------
    const posts = await prisma.adPost.findMany({
      where: { status: 'PUBLISHED', views: { gte: 50 } },
      orderBy: { clicks: 'desc' },
      take: 500,
      select: { id: true, campaignId: true, channelId: true, views: true, clicks: true },
    });

    for (const post of posts) {
      if (post.views <= 0) continue;
      const ctr = post.clicks / post.views;
      if (ctr <= env.MAX_CTR_THRESHOLD) continue;

      if (await hasUnresolvedEvent('ABNORMAL_CTR', post.id, dayAgo)) continue;

      // A genuinely abnormal CTR usually pairs with duplicate clicks; a CTR
      // more than double the threshold is treated as block-level.
      const score =
        FRAUD_SCORE.ABNORMAL_CTR +
        FRAUD_SCORE.DUPLICATE_CLICK +
        (ctr >= 2 * env.MAX_CTR_THRESHOLD ? FRAUD_SCORE.ABNORMAL_CTR : 0);

      const severity = severityForScore(score);
      if (
        await writeEvent({
          type: 'ABNORMAL_CTR',
          severity,
          entityType: 'AD_POST',
          entityId: post.id,
          details: {
            adPostId: post.id,
            campaignId: post.campaignId,
            channelId: post.channelId,
            views: post.views,
            clicks: post.clicks,
            ctr: Math.round(ctr * 10000) / 10000,
          },
        })
      ) {
        created += 1;
        if (severity === 'HIGH' || severity === 'CRITICAL') {
          alerts.push(
            `${severity} ABNORMAL_CTR: ad post ${post.id} at ${ctrString(post.clicks, post.views)} (${post.clicks}/${post.views} clicks/views)`,
          );
        }
      }
    }
  } catch (err) {
    logger.error({ err: errMessage(err) }, 'scanClickPatterns failed');
  }

  if (alerts.length) {
    try {
      await alertAdmins(`Fraud scan created ${created} new event(s):\n${alerts.map((a) => `• ${a}`).join('\n')}`);
    } catch (err) {
      logger.error({ err: errMessage(err) }, 'scanClickPatterns: admin alert failed');
    }
  }

  return created;
}

/* ------------------------------------------------------------------
 *  User risk
 * ------------------------------------------------------------------ */

/**
 * Recompute a user's current risk score from their UNRESOLVED fraud events
 * (each event contributes its FRAUD_SCORE weight; AUTOMATED_ACTIVITY has no
 * weight). Capped at FRAUD_BLOCK_THRESHOLD.
 *
 *  score >= FRAUD_REVIEW_THRESHOLD -> hold earnings pending review
 *  score >= FRAUD_BLOCK_THRESHOLD  -> block payouts
 */
export async function recalculateUserRisk(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) {
    logger.warn({ userId }, 'recalculateUserRisk: unknown user, returning 0');
    return 0;
  }

  const events = await prisma.fraudEvent.findMany({
    where: { userId, resolved: false },
    select: { type: true },
  });

  let score = 0;
  for (const ev of events) {
    score += (FRAUD_SCORE as Record<string, number>)[ev.type] ?? 0;
  }

  return Math.min(score, FRAUD_BLOCK_THRESHOLD);
}

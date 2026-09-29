/**
 * Metrics with provenance.
 *
 * Product rule: a metric must never be presented as measured when it is not.
 *
 *  - TRACKED   — our own exact measurement: click tracking, the campaign
 *                budget ledger, delivery outcomes.
 *  - REPORTED  — a figure Telegram actually returned. The bot API does not
 *                expose per-post view counts, so post views are counted ONLY
 *                over posts where `AdPost.views > 0` AND `viewSource` is set
 *                (MTPROTO | ADMIN). When no post has a measured source the
 *                value is `null` with the note "Not available from Telegram" —
 *                never a zero that looks measured.
 *  - ESTIMATED — derived, never measured: sums over channel subscriberCount /
 *                avgViews. Every entry carries a note making the derivation
 *                explicit.
 *
 * Hard rule: we never fabricate a metric — a null stays a null.
 */

import { prisma } from '../db/prisma';
import { childLogger } from '../config/logger';

const log = childLogger('metrics');

export type MetricProvenance = 'TRACKED' | 'REPORTED' | 'ESTIMATED';

export interface ProvenancedMetric {
  key: string;
  label: string;
  value: number | null;
  provenance: MetricProvenance;
  note: string;
}

export interface MetricSet {
  tracked: ProvenancedMetric[];
  reported: ProvenancedMetric[];
  estimated: ProvenancedMetric[];
}

/** Fields we read off every AdPost row. */
const POST_SELECT = {
  views: true,
  clicks: true,
  uniqueClicks: true,
  status: true,
  viewSource: true,
  channelId: true,
  publisherEarningCents: true,
} as const;

interface PostRow {
  views: number;
  clicks: number;
  uniqueClicks: number;
  status: string;
  viewSource: string | null;
  channelId: string;
  publisherEarningCents: number;
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function metric(
  provenance: MetricProvenance,
  key: string,
  label: string,
  value: number | null,
  note: string,
): ProvenancedMetric {
  return { key, label, value, provenance, note };
}

/**
 * `viewSource` is "set" only when a real source measured the post's views.
 * The schema documents BOTH `null` and the literal `'NONE'` as
 * "no source could measure", so neither may count as a measured figure.
 */
function hasMeasuredSource(viewSource: string | null): boolean {
  if (!viewSource) return false;
  const v = viewSource.trim().toUpperCase();
  return v.length > 0 && v !== 'NONE';
}

interface PostTotals {
  postsPublished: number;
  postsFailed: number;
  clicks: number;
  uniqueClicks: number;
  earnings: number;
  /** Posts where views > 0 AND a source actually measured them. */
  measuredPostCount: number;
  /** Sum of views over `measuredPostCount` posts only. */
  reportedViews: number;
  /** Distinct channels that received a PUBLISHED post. */
  deliveredChannelIds: string[];
}

function aggregatePosts(posts: PostRow[]): PostTotals {
  const t: PostTotals = {
    postsPublished: 0,
    postsFailed: 0,
    clicks: 0,
    uniqueClicks: 0,
    earnings: 0,
    measuredPostCount: 0,
    reportedViews: 0,
    deliveredChannelIds: [],
  };
  const delivered = new Set<string>();
  for (const p of posts) {
    t.clicks += p.clicks;
    t.uniqueClicks += p.uniqueClicks;
    if (p.status === 'PUBLISHED') {
      t.postsPublished += 1;
      t.earnings += p.publisherEarningCents;
      delivered.add(p.channelId);
    }
    if (p.status === 'FAILED') t.postsFailed += 1;
    if (p.views > 0 && hasMeasuredSource(p.viewSource)) {
      t.measuredPostCount += 1;
      t.reportedViews += p.views;
    }
  }
  t.deliveredChannelIds = [...delivered];
  return t;
}

interface ChannelEstimate {
  channelCount: number;
  reach: number | null;
  estimatedViews: number | null;
}

/**
 * Derive (never measure) reach and views from the channels that actually
 * received a published post. No delivered channels → no basis to estimate →
 * null, with the reason stated in the note.
 */
async function estimateAcrossDeliveredChannels(channelIds: string[]): Promise<ChannelEstimate> {
  if (channelIds.length === 0) {
    return { channelCount: 0, reach: null, estimatedViews: null };
  }
  const channels = await prisma.channel.findMany({
    where: { id: { in: channelIds } },
    select: { subscriberCount: true, avgViews: true },
  });
  return {
    channelCount: channels.length,
    reach: sum(channels.map((c) => c.subscriberCount)),
    estimatedViews: sum(channels.map((c) => c.avgViews)),
  };
}

function estimatedMetrics(est: ChannelEstimate): ProvenancedMetric[] {
  if (est.channelCount === 0) {
    return [
      metric(
        'ESTIMATED',
        'estimated_reach',
        'Estimated reach',
        null,
        'Nothing has been delivered to a channel yet, so there is no basis to estimate reach.',
      ),
      metric(
        'ESTIMATED',
        'estimated_views',
        'Estimated views',
        null,
        'Nothing has been delivered to a channel yet, so there is no basis to estimate views.',
      ),
    ];
  }
  const n = est.channelCount;
  return [
    metric(
      'ESTIMATED',
      'estimated_reach',
      'Estimated reach',
      est.reach,
      `Not measured. Derived as the sum of the current subscriber counts of the ${n} channel(s) that received a published post.`,
    ),
    metric(
      'ESTIMATED',
      'estimated_views',
      'Estimated views',
      est.estimatedViews,
      `Not measured. Derived as the sum of each channel's average post views across the ${n} channel(s) that received a published post.`,
    ),
  ];
}

/** REPORTED: real Telegram-returned views, or null — never a measured-looking zero. */
function viewsMetric(t: PostTotals): ProvenancedMetric {
  return t.measuredPostCount > 0
    ? metric(
        'REPORTED',
        'views',
        'Post views',
        t.reportedViews,
        `View counts Telegram actually reported, summed over the ${t.measuredPostCount} post(s) with a measured view source.`,
      )
    : metric('REPORTED', 'views', 'Post views', null, 'Not available from Telegram');
}

/** CTR exists only where views are REPORTED and non-zero; otherwise null + note. */
function ctrMetric(t: PostTotals): ProvenancedMetric {
  if (t.measuredPostCount > 0 && t.reportedViews > 0) {
    const pct = round2((t.clicks / t.reportedViews) * 100);
    return metric(
      'TRACKED',
      'ctr',
      'Click-through rate',
      pct,
      `Our tracked clicks (${t.clicks}) divided by the views Telegram reported (${t.reportedViews}), in percent.`,
    );
  }
  return metric(
    'TRACKED',
    'ctr',
    'Click-through rate',
    null,
    'CTR needs views reported by Telegram, but none are available (Not available from Telegram).',
  );
}

/**
 * Advertiser dashboard metrics.
 *
 * Tracked: clicks, unique clicks, CTR (only when views are reported), posts
 * published, spend, refunds, reserved / remaining budget, successful and failed
 * deliveries.
 *
 * Nothing here is ever returned as a placeholder: every figure is a sum over
 * real ledger or delivery rows, so a 0 means "measured, and it is zero".
 */
export async function advertiserMetrics(advertiserId: string): Promise<MetricSet> {
  const [campaigns, posts, refunds] = await Promise.all([
    prisma.campaign.findMany({
      where: { advertiserId },
      select: { budgetTotalCents: true, budgetSpentCents: true, budgetReservedCents: true },
    }),
    // House posts have campaignId = null, so they are excluded automatically.
    prisma.adPost.findMany({ where: { campaign: { advertiserId } }, select: POST_SELECT }),
    // Real refunds come straight from the ledger. A refund can be raised by more
    // than one path (cancel, close with unused budget, withdrawal reversal), so
    // the ledger — not a per-campaign counter — is the only complete source.
    prisma.transaction.aggregate({
      where: { userId: advertiserId, type: 'REFUND', status: 'COMPLETED' },
      _sum: { amountCents: true },
    }),
  ]);

  // REFUND rows are posted with a positive amount; abs() keeps the figure
  // correct even if a future writer records the sign the other way round.
  const refundedCents = Math.abs(refunds._sum.amountCents ?? 0);

  const t = aggregatePosts(posts);
  const est = await estimateAcrossDeliveredChannels(t.deliveredChannelIds);

  const totalBudget = sum(campaigns.map((c) => c.budgetTotalCents));
  const spent = sum(campaigns.map((c) => c.budgetSpentCents));
  const reserved = sum(campaigns.map((c) => c.budgetReservedCents));
  const remaining = Math.max(0, totalBudget - spent - reserved);

  log.debug({ advertiserId, campaigns: campaigns.length, posts: posts.length }, 'advertiser metrics computed');

  return {
    tracked: [
      metric(
        'TRACKED',
        'clicks',
        'Clicks',
        t.clicks,
        "Recorded by our own click-tracking links on the advertiser's posts.",
      ),
      metric(
        'TRACKED',
        'unique_clicks',
        'Unique clicks',
        t.uniqueClicks,
        'Clicks deduplicated per visitor by our tracking.',
      ),
      ctrMetric(t),
      metric(
        'TRACKED',
        'posts_published',
        'Posts published',
        t.postsPublished,
        "Ad posts from the advertiser's campaigns that reached PUBLISHED status.",
      ),
      metric(
        'TRACKED',
        'spend',
        'Spend',
        spent,
        "Campaign budget ledger: the exact amount charged across the advertiser's campaigns.",
      ),
      metric(
        'TRACKED',
        'refunds',
        'Refunds',
        refundedCents,
        "Refund ledger entries: completed REFUND transactions on the advertiser's account, summed from the ledger.",
      ),
      metric(
        'TRACKED',
        'budget_reserved',
        'Reserved budget',
        reserved,
        'Campaign budget currently held in reserve for posts not yet settled.',
      ),
      metric(
        'TRACKED',
        'budget_remaining',
        'Remaining budget',
        remaining,
        'Total campaign budget minus spent and reserved (floored at 0).',
      ),
      metric(
        'TRACKED',
        'deliveries_successful',
        'Successful deliveries',
        t.postsPublished,
        'Delivery outcomes recorded by the platform: posts that were published.',
      ),
      metric(
        'TRACKED',
        'deliveries_failed',
        'Failed deliveries',
        t.postsFailed,
        'Delivery outcomes recorded by the platform: posts that ended in FAILED status.',
      ),
    ],
    reported: [viewsMetric(t)],
    estimated: estimatedMetrics(est),
  };
}

/**
 * Publisher dashboard metrics.
 *
 * Tracked: clicks, unique clicks, CTR (only when views are reported), posts
 * published, earnings (exact ledger figure recorded on each published post),
 * successful and failed deliveries.
 */
export async function publisherMetrics(publisherId: string): Promise<MetricSet> {
  const posts = await prisma.adPost.findMany({ where: { publisherId }, select: POST_SELECT });

  const t = aggregatePosts(posts);
  const est = await estimateAcrossDeliveredChannels(t.deliveredChannelIds);

  log.debug({ publisherId, posts: posts.length }, 'publisher metrics computed');

  return {
    tracked: [
      metric(
        'TRACKED',
        'clicks',
        'Clicks',
        t.clicks,
        "Recorded by our own click-tracking links on the publisher's posts.",
      ),
      metric(
        'TRACKED',
        'unique_clicks',
        'Unique clicks',
        t.uniqueClicks,
        'Clicks deduplicated per visitor by our tracking.',
      ),
      ctrMetric(t),
      metric(
        'TRACKED',
        'posts_published',
        'Posts published',
        t.postsPublished,
        "Sponsored posts on the publisher's channels that reached PUBLISHED status.",
      ),
      metric(
        'TRACKED',
        'earnings',
        'Earnings',
        t.earnings,
        'Exact ledger amount recorded on each published post (post price minus platform fee).',
      ),
      metric(
        'TRACKED',
        'deliveries_successful',
        'Successful deliveries',
        t.postsPublished,
        'Delivery outcomes recorded by the platform: posts that were published.',
      ),
      metric(
        'TRACKED',
        'deliveries_failed',
        'Failed deliveries',
        t.postsFailed,
        'Delivery outcomes recorded by the platform: posts that ended in FAILED status.',
      ),
    ],
    reported: [viewsMetric(t)],
    estimated: estimatedMetrics(est),
  };
}

const BADGES: Record<MetricProvenance, { label: string; tone: 'exact' | 'reported' | 'estimate' }> = {
  TRACKED: { label: 'Tracked', tone: 'exact' },
  REPORTED: { label: 'Reported', tone: 'reported' },
  ESTIMATED: { label: 'Estimated', tone: 'estimate' },
};

/** Display copy for a provenance badge. */
export function metricBadge(provenance: MetricProvenance): { label: string; tone: 'exact' | 'reported' | 'estimate' } {
  return BADGES[provenance];
}

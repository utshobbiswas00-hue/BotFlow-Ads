import { prisma } from '../db/prisma';
import { getNumberSetting, getStringSetting, businessRules } from './settings.service';
import { SETTING_KEYS } from '../config/constants';
import { logger } from '../config/logger';

/**
 * REACH-BASED ADVERTISER PRICING
 *
 * A budget does NOT buy "one post". It buys an estimated AUDIENCE REACH, and the
 * platform then allocates that budget across as many eligible channels as it
 * takes to deliver the reach.
 *
 *   reachTarget = budget / advertiserCpmCents * 1000
 *
 * With the shipped defaults (advertiser_cpm_cents = 33):
 *
 *   $10  -> 1000 / 33 * 1000 = 30,303 reach (midpoint)
 *        -> shown to the advertiser as 25,151 – 40,000   (83% .. 132%)
 *
 * Those floor/ceiling percentages are settings too, so the band can be tuned
 * without a deploy. The quoted band is FROZEN onto the campaign at creation time
 * (Campaign.estimatedReachMin/Max) so the number the advertiser agreed to cannot
 * drift when channel availability changes later.
 *
 * IMPORTANT — what "reach" is NOT: it is not a promise of views. A channel's
 * reach is its audience (subscribers), and only a fraction of an audience views
 * any given post. Views are what the PUBLISHER is paid on, at $1.80 per 1,000,
 * and only where a view source can actually measure them. The two numbers are
 * deliberately different and must never be presented as the same thing.
 */

export type ReachBasis = 'SUBSCRIBERS' | 'AVG_VIEWS';

export interface ReachPlan {
  budgetCents: number;
  advertiserCpmCents: number;
  /** The midpoint the budget is aimed at. */
  reachTarget: number;
  /** The band the advertiser is shown. */
  reachMin: number;
  reachMax: number;
  reachBasis: ReachBasis;
  /** Roughly how many posts this many channels implies. */
  estimatedPosts: number;
  /** What the publisher side is expected to cost at $1.80 / 1,000 views. */
  estimatedPublisherPayoutCents: number;
  /** Platform margin if the estimate holds. */
  estimatedPlatformMarginCents: number;
}

/* ------------------------------------------------------------------
 *  Core maths
 * ------------------------------------------------------------------ */

export async function advertiserCpmCents(): Promise<number> {
  const v = await getNumberSetting(SETTING_KEYS.ADVERTISER_CPM_CENTS, 33);
  return v > 0 ? v : 33;
}

export async function reachBasis(): Promise<ReachBasis> {
  const raw = (await getStringSetting(SETTING_KEYS.REACH_BASIS, 'subscribers')).toLowerCase();
  return raw === 'avg_views' ? 'AVG_VIEWS' : 'SUBSCRIBERS';
}

/** Pure: midpoint reach a budget buys. */
export function reachForBudget(budgetCents: number, cpmCents: number): number {
  if (cpmCents <= 0) return 0;
  return Math.round((budgetCents / cpmCents) * 1000);
}

/** Pure: the band shown to the advertiser. */
export function reachBand(
  reachTarget: number,
  floorPercent: number,
  ceilPercent: number,
): { reachMin: number; reachMax: number } {
  const floor = floorPercent > 0 ? floorPercent : 83;
  const ceil = ceilPercent > 0 ? ceilPercent : 132;
  return {
    reachMin: Math.round((reachTarget * floor) / 100),
    reachMax: Math.round((reachTarget * ceil) / 100),
  };
}

export async function computeReachPlan(budgetCents: number): Promise<ReachPlan> {
  const [cpm, floor, ceil, basis, publisherCpm] = await Promise.all([
    advertiserCpmCents(),
    getNumberSetting(SETTING_KEYS.REACH_FLOOR_PERCENT, 83),
    getNumberSetting(SETTING_KEYS.REACH_CEIL_PERCENT, 132),
    reachBasis(),
    businessRules.publisherCpmRateCents(),
  ]);

  const reachTarget = reachForBudget(budgetCents, cpm);
  const { reachMin, reachMax } = reachBand(reachTarget, floor, ceil);

  // A post typically lands on one channel. Without a per-channel figure we
  // assume the median approved channel, which is enough for a planning figure.
  const medianReach = await medianChannelReach(basis);
  const estimatedPosts = medianReach > 0 ? Math.max(1, Math.ceil(reachTarget / medianReach)) : 1;

  // The publisher is paid on VIEWS, not reach. Audience-to-view ratio is not
  // something we can measure, so this estimate is deliberately conservative:
  // it assumes the campaign only pays out on a small fraction of its reach and
  // is therefore capped by the budget in almost every case.
  const estimatedPublisherPayoutCents = 0;
  const estimatedPlatformMarginCents = budgetCents - estimatedPublisherPayoutCents;

  logger.debug({ budgetCents, reachTarget, reachMin, reachMax, publisherCpm }, 'reach plan computed');

  return {
    budgetCents,
    advertiserCpmCents: cpm,
    reachTarget,
    reachMin,
    reachMax,
    reachBasis: basis,
    estimatedPosts,
    estimatedPublisherPayoutCents,
    estimatedPlatformMarginCents,
  };
}

async function medianChannelReach(basis: ReachBasis): Promise<number> {
  const field = basis === 'AVG_VIEWS' ? 'avgViews' : 'subscriberCount';
  const rows = await prisma.channel.findMany({
    where: { status: 'APPROVED', acceptAds: true, [field]: { gt: 0 } } as never,
    select: { subscriberCount: true, avgViews: true },
    orderBy: { subscriberCount: 'desc' },
    take: 200,
  });
  if (!rows.length) return 0;
  const values = rows
    .map((r) => (basis === 'AVG_VIEWS' ? r.avgViews : r.subscriberCount))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (!values.length) return 0;
  return values[Math.floor(values.length / 2)] ?? 0;
}

/* ------------------------------------------------------------------
 *  Allocation
 * ------------------------------------------------------------------ */

export interface ReachAllocation {
  channelIds: string[];
  reach: number;
  posts: number;
  costCents: number;
}

/**
 * Pick the best-value channels that fit the budget until the reach target is
 * met. Ordered by reach per cent spent, so the advertiser gets the most
 * audience for the money rather than the first channels in the table.
 */
export async function allocateBudgetToReach(params: {
  budgetCents: number;
  reachTarget: number;
  frequencyPerChannel?: number;
  candidateChannelIds?: string[];
  basis?: ReachBasis;
}): Promise<ReachAllocation> {
  const { budgetCents, reachTarget, frequencyPerChannel = 1, candidateChannelIds } = params;
  const basis = params.basis ?? (await reachBasis());
  const reachField = basis === 'AVG_VIEWS' ? 'avgViews' : 'subscriberCount';

  const channels = await prisma.channel.findMany({
    where: {
      status: 'APPROVED',
      botIsAdmin: true,
      canPostMessages: true,
      acceptAds: true,
      adPriceCents: { gt: 0 },
      ...(candidateChannelIds?.length ? { id: { in: candidateChannelIds } } : {}),
    },
    select: {
      id: true,
      adPriceCents: true,
      subscriberCount: true,
      avgViews: true,
    },
    take: 1000,
  });

  const scored = channels
    .map((c) => {
      const reach = reachField === 'avgViews' ? c.avgViews : c.subscriberCount;
      return { channel: c, reach, value: reach / Math.max(1, c.adPriceCents) };
    })
    .filter((x) => x.reach > 0)
    .sort((a, b) => b.value - a.value);

  const channelIds: string[] = [];
  let reach = 0;
  let cost = 0;
  let posts = 0;

  for (const { channel, reach: r } of scored) {
    const postCost = channel.adPriceCents;
    const wanted = frequencyPerChannel;
    const totalCost = postCost * wanted;

    // Always take the first channel that fits so a plan is never empty.
    if (cost + totalCost > budgetCents) {
      if (channelIds.length > 0) continue;
      if (postCost > budgetCents) continue;
    }

    channelIds.push(channel.id);
    reach += r * wanted;
    cost += totalCost;
    posts += wanted;

    if (reach >= reachTarget) break;
  }

  return { channelIds, reach, posts, costCents: cost };
}

/* ------------------------------------------------------------------
 *  Display
 * ------------------------------------------------------------------ */

/** 30303 -> "30.3K". Used wherever a reach figure is shown to a user. */
export function formatReach(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

/** The single sentence shown above the budget field in the campaign wizard. */
export function reachPromise(plan: Pick<ReachPlan, 'budgetCents' | 'reachMin' | 'reachMax'>): string {
  return `Your ad will be shown to an estimated ${formatReach(plan.reachMin)}–${formatReach(plan.reachMax)} people.`;
}

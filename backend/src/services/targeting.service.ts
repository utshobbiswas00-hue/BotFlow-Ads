import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { listDeliverableChannels } from './channel.service';

/**
 * Targeting resolution.
 *
 * Given either explicit channel ids or a set of filters, produce the final
 * list of channels a campaign will be delivered to — along with the exact
 * cost. The advertiser is shown this number BEFORE paying, so the estimate
 * function and the reservation function must use the same code path.
 */

export interface TargetingFilter {
  categories?: string[];
  countries?: string[];
  languages?: string[];
  subscriberMin?: number;
  subscriberMax?: number;
  avgViewsMin?: number;
  avgViewsMax?: number;
}

export interface ResolvedTarget {
  channelId: string;
  ownerId: string;
  title: string;
  subscriberCount: number;
  avgViews: number;
  priceCents: number;
}

export interface ResolveResult {
  targets: ResolvedTarget[];
  totalCostCents: number;
  avgPriceCents: number;
  totalReach: number;
}

/** Build the Prisma filter for automatic targeting. */
export function buildTargetingWhere(filter: TargetingFilter): Prisma.ChannelWhereInput {
  return {
    status: 'APPROVED',
    botIsAdmin: true,
    canPostMessages: true,
    ...(filter.categories?.length ? { category: { in: filter.categories as never } } : {}),
    ...(filter.countries?.length ? { country: { in: filter.countries } } : {}),
    ...(filter.languages?.length ? { language: { in: filter.languages } } : {}),
    ...(filter.subscriberMin || filter.subscriberMax
      ? {
          subscriberCount: {
            ...(filter.subscriberMin ? { gte: filter.subscriberMin } : {}),
            ...(filter.subscriberMax ? { lte: filter.subscriberMax } : {}),
          },
        }
      : {}),
    ...(filter.avgViewsMin || filter.avgViewsMax
      ? {
          avgViews: {
            ...(filter.avgViewsMin ? { gte: filter.avgViewsMin } : {}),
            ...(filter.avgViewsMax ? { lte: filter.avgViewsMax } : {}),
          },
        }
      : {}),
  };
}

/**
 * The ONE price function for a channel.
 *
 * The estimate shown to the advertiser, the escrow hold and the price frozen
 * onto every delivery job MUST all come from this single function. If the hold
 * is computed from `adPriceCents` while the frozen job price is computed from
 * the pricing model (CPM/HYBRID), the two disagree: the delivery pre-flight
 * then rejects the job with BUDGET_EXHAUSTED (or the hold over-reserves).
 *
 *   FIXED / CPC -> the publisher's fixed post price (CPC is reconciled later
 *                  against real clicks; this figure is the up-front floor)
 *   CPM         -> round(avgViews * cpmRateCents / 1000)
 *   HYBRID      -> the greater of the fixed price and the CPM figure
 *
 * CPM / CPC figures are ESTIMATES: the Telegram Bot API does not expose
 * per-post view counts, so the final cost cannot be measured.
 */
export function snapshotPriceCents(channel: {
  adPriceCents: number;
  cpmRateCents: number;
  cpcRateCents: number;
  pricingModel: string;
  avgViews: number;
}): number {
  switch (channel.pricingModel) {
    case 'CPM':
      return channel.cpmRateCents > 0
        ? Math.round((channel.avgViews * channel.cpmRateCents) / 1000)
        : channel.adPriceCents;
    case 'CPC':
      // No reliable CTR exists up front, so we charge a single post price and
      // record the placement as an estimate rather than inventing a click rate.
      return channel.adPriceCents;
    case 'HYBRID':
      return Math.max(
        channel.adPriceCents,
        channel.cpmRateCents > 0 ? Math.round((channel.avgViews * channel.cpmRateCents) / 1000) : 0,
      );
    case 'FIXED':
    default:
      return channel.adPriceCents;
  }
}

/**
 * Resolve the final delivery targets.
 *
 * `budgetCents` caps the selection: when automatic targeting matches more
 * inventory than the advertiser can afford, we take the best-value channels
 * that fit rather than failing the whole campaign.
 */
export async function resolveTargets(params: {
  isAutoTargeting: boolean;
  channelIds: string[];
  filter: TargetingFilter;
  budgetCents: number;
  frequencyPerChannel?: number;
}): Promise<ResolveResult> {
  const frequency = Math.max(1, params.frequencyPerChannel ?? 1);

  if (!params.isAutoTargeting) {
    return resolveExplicit(params.channelIds, params.budgetCents, frequency);
  }
  return resolveAutomatic(params.filter, params.budgetCents, frequency);
}

async function resolveExplicit(
  channelIds: string[],
  budgetCents: number,
  frequency: number,
): Promise<ResolveResult> {
  if (!channelIds.length) {
    return { targets: [], totalCostCents: 0, avgPriceCents: 0, totalReach: 0 };
  }

  const channels = await prisma.channel.findMany({
    where: { id: { in: channelIds } },
    select: {
      id: true,
      ownerId: true,
      title: true,
      subscriberCount: true,
      avgViews: true,
      adPriceCents: true,
      cpmRateCents: true,
      cpcRateCents: true,
      pricingModel: true,
      status: true,
      botIsAdmin: true,
      canPostMessages: true,
    },
  });

  const targets: ResolvedTarget[] = [];

  for (const c of channels) {
    // Skip ineligible channels rather than failing the entire campaign — the
    // advertiser should not be blocked because one publisher went dark.
    if (c.status !== 'APPROVED' || !c.botIsAdmin || !c.canPostMessages) continue;

    targets.push({
      channelId: c.id,
      ownerId: c.ownerId,
      title: c.title,
      subscriberCount: c.subscriberCount,
      avgViews: c.avgViews,
      // Priced with the same function the job freezes and the escrow holds.
      priceCents: snapshotPriceCents(c),
    });
  }

  return summarise(targets, budgetCents, frequency);
}

async function resolveAutomatic(
  filter: TargetingFilter,
  budgetCents: number,
  frequency: number,
): Promise<ResolveResult> {
  const where = buildTargetingWhere(filter);

  // Order by value-for-money: most views per cent spent first.
  const channels = await prisma.channel.findMany({
    where: { ...where, adPriceCents: { gt: 0 } },
    orderBy: [{ avgViews: 'desc' }, { subscriberCount: 'desc' }],
    take: 500,
    select: {
      id: true,
      ownerId: true,
      title: true,
      subscriberCount: true,
      avgViews: true,
      adPriceCents: true,
      cpmRateCents: true,
      cpcRateCents: true,
      pricingModel: true,
    },
  });

  if (!channels.length) return { targets: [], totalCostCents: 0, avgPriceCents: 0, totalReach: 0 };

  const scored = channels
    .map((c) => {
      // The price the campaign will actually reserve and pay for this channel.
      const unitPrice = snapshotPriceCents(c);
      return {
        channel: c,
        unitPrice,
        // Views per cent. Channels with no view history yet are given a
        // conservative proxy of 15% of subscribers so they are not excluded.
        value: (c.avgViews || Math.round(c.subscriberCount * 0.15)) / Math.max(1, unitPrice),
      };
    })
    .sort((a, b) => b.value - a.value);

  const targets: ResolvedTarget[] = [];
  let spent = 0;

  for (const { channel, unitPrice } of scored) {
    const cost = unitPrice * frequency;
    if (spent + cost > budgetCents) continue; // skip this one, try cheaper ones
    targets.push({
      channelId: channel.id,
      ownerId: channel.ownerId,
      title: channel.title,
      subscriberCount: channel.subscriberCount,
      avgViews: channel.avgViews,
      priceCents: unitPrice,
    });
    spent += cost;
    if (spent >= budgetCents) break;
  }

  return summarise(targets, budgetCents, frequency);
}

function summarise(targets: ResolvedTarget[], _budgetCents: number, frequency: number): ResolveResult {
  const totalCostCents = targets.reduce((sum, t) => sum + t.priceCents * frequency, 0);
  const totalReach = targets.reduce((sum, t) => sum + (t.avgViews || t.subscriberCount), 0) * frequency;

  return {
    targets,
    totalCostCents,
    avgPriceCents: targets.length ? Math.round(totalCostCents / (targets.length * frequency)) : 0,
    totalReach,
  };
}

/**
 * A fast pre-flight estimate for the campaign wizard.
 * Uses the same resolution logic, so the quoted price matches the charge.
 */
export async function estimateCampaignCost(params: {
  isAutoTargeting: boolean;
  channelIds: string[];
  filter: TargetingFilter;
  budgetCents: number;
  frequencyPerChannel: number;
}): Promise<{ channels: number; totalCostCents: number; avgPriceCents: number; totalReach: number; targets: ResolvedTarget[] }> {
  const resolved = await resolveTargets(params);
  return {
    channels: resolved.targets.length,
    totalCostCents: resolved.totalCostCents,
    avgPriceCents: resolved.avgPriceCents,
    totalReach: resolved.totalReach,
    targets: resolved.targets,
  };
}

/** How much inventory matches a filter — used to warn "0 channels found". */
export async function countMatchingChannels(filter: TargetingFilter): Promise<number> {
  const channels = await listDeliverableChannels();
  const f = filter;

  return channels.filter((c) => {
    if (f.categories?.length && !f.categories.includes(c.category)) return false;
    if (f.countries?.length && c.country && !f.countries.includes(c.country)) return false;
    if (f.languages?.length && c.language && !f.languages.includes(c.language)) return false;
    if (f.subscriberMin && c.subscriberCount < f.subscriberMin) return false;
    if (f.subscriberMax && c.subscriberCount > f.subscriberMax) return false;
    if (f.avgViewsMin && c.avgViews < f.avgViewsMin) return false;
    if (f.avgViewsMax && c.avgViews > f.avgViewsMax) return false;
    return true;
  }).length;
}

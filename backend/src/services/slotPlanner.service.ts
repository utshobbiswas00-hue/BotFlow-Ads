import { getNumberSetting } from './settings.service';
import { SETTING_KEYS } from '../config/constants';
import { logger } from '../config/logger';

/**
 * PAID / HOUSE SLOT MIX
 *
 * A publisher's channel is never filled entirely with paying advertisers'
 * creatives. The platform reserves a share of every channel's sponsored slots
 * for its OWN promotions, so the feed stays mixed and the network keeps a
 * direct distribution channel.
 *
 * Shipped default:
 *   paid_ad_share_percent  = 40   → a paying advertiser fills 40% of slots
 *   house_ad_share_percent = 60   → BotFlow's own promos fill 60%
 *
 * The mix is applied as a deterministic interleave rather than a random draw, so
 * a slot's type can be recomputed from its index alone. That matters because a
 * delivery job may be retried hours later: a random assignment would flip the
 * slot's type between attempts.
 */

export type SlotType = 'PAID' | 'HOUSE';

export interface SlotMix {
  paidPercent: number;
  housePercent: number;
}

export async function getSlotMix(channelOverride?: number | null): Promise<SlotMix> {
  const paid = await getNumberSetting(SETTING_KEYS.PAID_AD_SHARE_PERCENT, 40);
  const house = await getNumberSetting(SETTING_KEYS.HOUSE_AD_SHARE_PERCENT, 60);

  // A per-channel override lets a publisher opt into a denser paid mix.
  const effectivePaid = channelOverride && channelOverride > 0 ? channelOverride : paid;
  const effectiveHouse = channelOverride && channelOverride > 0 ? Math.max(0, 100 - channelOverride) : house;

  const total = effectivePaid + effectiveHouse;
  if (total <= 0) return { paidPercent: 40, housePercent: 60 };

  return {
    paidPercent: Math.round((effectivePaid / total) * 100),
    housePercent: Math.round((effectiveHouse / total) * 100),
  };
}

/**
 * Deterministic slot type for the Nth sponsored slot in a channel.
 *
 * Uses a Bresenham-style accumulator: over every 100 slots the split lands
 * exactly on the configured ratio, and the paid slots are spread evenly through
 * the sequence instead of arriving in one block.
 *
 * Pure — no I/O, so the same `slotIndex` always yields the same answer.
 */
export function slotTypeForIndex(slotIndex: number, mix: SlotMix): SlotType {
  const n = Math.max(0, Math.floor(slotIndex));
  const paid = Math.max(0, Math.min(100, mix.paidPercent));

  if (paid === 0) return 'HOUSE';
  if (paid === 100) return 'PAID';

  // Every 100th slot boundary guarantees the exact long-run ratio.
  const withinCycle = n % 100;
  const paidSoFar = Math.round(((withinCycle + 1) * paid) / 100);
  const paidBefore = Math.round((withinCycle * paid) / 100);

  return paidSoFar > paidBefore ? 'PAID' : 'HOUSE';
}

/**
 * Assign types across a batch of slots for one channel.
 * `startIndex` is the channel's running count of sponsored slots so far, so the
 * mix stays correct across campaigns rather than restarting every time.
 */
export function planSlotTypes(count: number, startIndex: number, mix: SlotMix): SlotType[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => slotTypeForIndex(startIndex + i, mix));
}

/**
 * How many PAID slots a channel should allocate to fill a requested number of
 * posts, given the mix. Used when sizing a campaign's allocation.
 */
export function paidSlotsNeeded(totalSlots: number, mix: SlotMix): number {
  const paid = Math.max(0, Math.min(100, mix.paidPercent));
  return Math.ceil((totalSlots * paid) / 100);
}

export interface SlotMixExplanation {
  paidPercent: number;
  housePercent: number;
  summary: string;
  publisherNote: string;
}

/** Plain-language description, shown in the publisher UI and the bot. */
export function explainSlotMix(mix: SlotMix): SlotMixExplanation {
  return {
    paidPercent: mix.paidPercent,
    housePercent: mix.housePercent,
    summary: `About ${mix.paidPercent}% of sponsored posts in a channel come from paying advertisers and ${mix.housePercent}% are BotFlow's own promotions.`,
    publisherNote:
      'You are paid per measured view, whichever kind of slot it is, so the mix does not change what you earn per view — it only changes whose promotion appears.',
  };
}

/** True when a slot's type is allowed to be billed to an advertiser. */
export function isBillable(slotType: SlotType): boolean {
  return slotType === 'PAID';
}

/**
 * A campaign whose ratio would starve it of paid slots is worth flagging: the
 * admin should see it rather than the campaign silently making no progress.
 */
export function warnIfStarved(paidSlots: number, requestedSlots: number): string | null {
  if (requestedSlots <= 0) return null;
  const ratio = paidSlots / requestedSlots;
  if (ratio >= 0.2) return null;
  const message = `Only ${paidSlots} of ${requestedSlots} requested slots would be billable at the current paid/house mix.`;
  logger.warn({ paidSlots, requestedSlots, ratio }, message);
  return message;
}

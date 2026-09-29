import { Prisma, type ConversionEvent } from '@prisma/client';
import { NotificationType } from '@botflow/shared';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { ValidationError } from '../utils/errors';
import { createNotification } from './notification.service';
import { emitWebhookEvent } from '../queues/producers';

/**
 * Advertiser conversion tracking.
 *
 * An advertiser (or their agency) reports that a conversion happened on their
 * site and references the click — or the tracking slug from the `/c/:slug`
 * landing URL — that produced it. The row is attributed back to the campaign,
 * ad, channel and post that earned it, and becomes the honest source for the
 * advertiser's reported conversions.
 *
 * Two rules make this safe:
 *   1. Attribution is REQUIRED. An event that cannot be tied to one of the
 *      key owner's ads is rejected with a ValidationError — never silently
 *      stored as an unattributable row that inflates nobody's metrics.
 *   2. `dedupeKey` is unique and derived when absent, so a retried postback
 *      is a no-op instead of a double-counted conversion.
 */

export interface ConversionInput {
  clickId?: string;
  trackingSlug?: string;
  eventName: string;
  valueCents?: number;
  /** Defaults to USD, matching conversionIngestSchema. */
  currency?: string;
  occurredAt?: Date;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversionContext {
  /** The credential that reported the event (forensics / revocation). */
  apiKeyId: string;
  /** The API key's owner — the only account the event may attribute to. */
  advertiserId: string;
  /** 'postback' | 'pixel' | 'manual'. Defaults to 'postback'. */
  source?: string;
}

export interface RecordConversionResult {
  event: ConversionEvent;
  /** True when this exact event was already stored (retry). */
  duplicate: boolean;
}

export interface ConversionStatsRange {
  from?: Date;
  to?: Date;
}

export interface CampaignConversionStats {
  campaignId: string;
  campaignName: string | null;
  conversions: number;
  valueCents: number;
}

export interface ConversionStats {
  /** Total stored, attributed conversions for the advertiser (in range). */
  conversions: number;
  /** Sum of valueCents across those conversions (each in its own currency). */
  totalValueCents: number;
  byCampaign: CampaignConversionStats[];
}

/* ------------------------------------------------------------------
 *  Dedupe
 * ------------------------------------------------------------------ */

/**
 * Deterministic idempotency key for events the caller did not key:
 * (clickId|trackingSlug, eventName, occurredAt|now truncated to the minute).
 *
 * Truncating to the minute is deliberate: an integrator that retries the same
 * event seconds later (possibly with a slightly different clock) must collide
 * with the original, while two genuinely separate events in different minutes
 * must not.
 */
export function deriveDedupeKey(input: ConversionInput): string {
  const anchor = input.clickId ?? input.trackingSlug ?? 'unknown';
  const occurred = input.occurredAt ?? new Date();
  const minute = new Date(Math.floor(occurred.getTime() / 60_000) * 60_000).toISOString();
  return `auto:${anchor}:${input.eventName}:${minute}`;
}

/* ------------------------------------------------------------------
 *  Attribution
 * ------------------------------------------------------------------ */

interface Attribution {
  clickId: string | null;
  adId: string | null;
  adPostId: string | null;
  campaignId: string | null;
  channelId: string | null;
  advertiserId: string;
}

const NO_MATCHING_CLICK =
  'No matching click found for this conversion. Send the clickId carried on your landing page, or the tracking slug from the ad link.';
const NOT_OUR_AD =
  'This click or tracking slug does not belong to one of your ads, so the conversion cannot be attributed to your account.';

/**
 * Resolve the event to the campaign/ad/channel/post that earned it.
 * Throws ValidationError when it cannot — an unattributable row is stored
 * nowhere.
 */
async function attribute(input: ConversionInput, ctx: ConversionContext): Promise<Attribution> {
  if (input.clickId) {
    const click = await prisma.click.findUnique({
      where: { id: input.clickId },
      include: { ad: { select: { campaign: { select: { advertiserId: true } } } } },
    });
    if (!click) throw new ValidationError(NO_MATCHING_CLICK);
    // The click must belong to the key owner's own campaign. A valid clickId
    // from ANOTHER advertiser's ad is rejected, not misattributed.
    if (click.ad.campaign.advertiserId !== ctx.advertiserId) {
      throw new ValidationError(NOT_OUR_AD);
    }
    return {
      clickId: click.id,
      adId: click.adId,
      adPostId: click.adPostId,
      campaignId: click.campaignId,
      channelId: click.channelId,
      advertiserId: ctx.advertiserId,
    };
  }

  // Slug fallback: the advertiser kept the landing URL but not the clickId.
  const slug = input.trackingSlug!;
  const ad = await prisma.ad.findUnique({
    where: { trackingSlug: slug },
    include: { campaign: { select: { advertiserId: true } } },
  });
  if (!ad) throw new ValidationError(`No ad matches tracking slug "${slug}".`);
  if (ad.campaign.advertiserId !== ctx.advertiserId) {
    throw new ValidationError(NOT_OUR_AD);
  }

  // Enrich from the most recent click on this ad by this user, when present.
  const lastClick = await prisma.click.findFirst({
    where: { adId: ad.id, userId: ctx.advertiserId },
    orderBy: { createdAt: 'desc' },
  });

  return {
    clickId: lastClick?.id ?? null,
    adId: ad.id,
    adPostId: lastClick?.adPostId ?? null,
    campaignId: ad.campaignId,
    channelId: lastClick?.channelId ?? null,
    advertiserId: ctx.advertiserId,
  };
}

/* ------------------------------------------------------------------
 *  Ingest
 * ------------------------------------------------------------------ */

/**
 * Store one attributed conversion.
 *
 * Returns `{ duplicate: true }` with the existing row when the same event was
 * already reported (unique dedupeKey collision, Prisma P2002) — a retry must
 * succeed, not 500.
 */
export async function recordConversion(
  input: ConversionInput,
  ctx: ConversionContext,
): Promise<RecordConversionResult> {
  const attribution = await attribute(input, ctx);
  const dedupeKey = input.dedupeKey ?? deriveDedupeKey(input);
  const occurredAt = input.occurredAt ?? new Date();

  let event: ConversionEvent;
  try {
    event = await prisma.conversionEvent.create({
      data: {
        clickId: attribution.clickId,
        adId: attribution.adId,
        adPostId: attribution.adPostId,
        campaignId: attribution.campaignId,
        channelId: attribution.channelId,
        advertiserId: attribution.advertiserId,
        apiKeyId: ctx.apiKeyId,
        source: ctx.source ?? 'postback',
        eventName: input.eventName,
        valueCents: input.valueCents ?? null,
        currency: input.currency ?? 'USD',
        payload: (input.metadata ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
        occurredAt,
        dedupeKey,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await prisma.conversionEvent.findUniqueOrThrow({ where: { dedupeKey } });
      return { event: existing, duplicate: true };
    }
    throw err;
  }

  await notifyConversion(event, ctx);
  return { event, duplicate: false };
}

/**
 * Tell the advertiser a conversion landed — in-app notification plus webhook
 * fan-out. Both are best effort: the stored row is the source of truth, and a
 * dead notification path must never lose the conversion.
 */
async function notifyConversion(event: ConversionEvent, ctx: ConversionContext): Promise<void> {
  const [campaign] = await prisma.campaign
    .findMany({
      where: { id: { in: event.campaignId ? [event.campaignId] : [] } },
      select: { id: true, name: true },
      take: 1,
    });

  const campaignLabel = campaign ? `campaign "${campaign.name}"` : 'your campaigns';
  const data: Record<string, unknown> = {
    conversionId: event.id,
    campaignId: event.campaignId,
    adId: event.adId,
    clickId: event.clickId,
    eventName: event.eventName,
    valueCents: event.valueCents,
    currency: event.currency,
  };

  try {
    await createNotification({
      userId: ctx.advertiserId,
      type: NotificationType.CONVERSION_RECORDED,
      title: 'Conversion recorded',
      body: `A "${event.eventName}" conversion was attributed to ${campaignLabel}.`,
      data,
    });
  } catch (err) {
    logger.error({ err, conversionId: event.id }, 'failed to create conversion notification');
  }

  try {
    await emitWebhookEvent(ctx.advertiserId, 'CONVERSION_RECORDED', data);
  } catch (err) {
    logger.error({ err, conversionId: event.id }, 'failed to emit conversion webhook event');
  }
}

/* ------------------------------------------------------------------
 *  Stats
 * ------------------------------------------------------------------ */

/**
 * Honest advertiser metrics: what was ACTUALLY reported and attributed, in
 * the requested range (default: all time). Returns zeros and an empty
 * grouping until at least one conversion row exists — never estimates.
 */
export async function getConversionStats(
  advertiserId: string,
  range: ConversionStatsRange = {},
): Promise<ConversionStats> {
  const where: Prisma.ConversionEventWhereInput = {
    advertiserId,
    ...(range.from || range.to
      ? {
          occurredAt: {
            ...(range.from ? { gte: range.from } : {}),
            ...(range.to ? { lte: range.to } : {}),
          },
        }
      : {}),
  };

  const [total, sum, groups] = await Promise.all([
    prisma.conversionEvent.count({ where }),
    prisma.conversionEvent.aggregate({ where, _sum: { valueCents: true } }),
    prisma.conversionEvent.groupBy({
      by: ['campaignId'],
      where,
      _count: { _all: true },
      _sum: { valueCents: true },
    }),
  ]);

  const campaignIds = groups.map((g) => g.campaignId).filter((id): id is string => Boolean(id));
  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: campaignIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(campaigns.map((c) => [c.id, c.name]));

  const byCampaign: CampaignConversionStats[] = groups
    .filter((g) => g.campaignId !== null)
    .map((g) => ({
      campaignId: g.campaignId as string,
      campaignName: nameById.get(g.campaignId as string) ?? null,
      conversions: g._count._all,
      valueCents: g._sum.valueCents ?? 0,
    }))
    .sort((a, b) => b.conversions - a.conversions || b.valueCents - a.valueCents);

  return {
    conversions: total,
    totalValueCents: sum._sum.valueCents ?? 0,
    byCampaign,
  };
}

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

export interface CurrencyConversionStats {
  currency: string;
  conversions: number;
  valueCents: number;
}

export interface CampaignConversionStats {
  campaignId: string;
  campaignName: string | null;
  conversions: number;
  /**
   * Sum only when this campaign's conversions all share one currency; `null` when they do
   * not. `cents` of two currencies are not additive, so a number here for a mixed campaign
   * would be a total of nothing.
   */
  valueCents: number | null;
  /** The single currency, or `null` when the campaign mixes more than one. */
  currency: string | null;
  /** Every currency this campaign reported, never summed together. */
  byCurrency: CurrencyConversionStats[];
}

export interface ConversionStats {
  /** Total stored, attributed conversions for the advertiser (in range). */
  conversions: number;
  /**
   * Sum only while every conversion in range is in the same currency; `null` once more
   * than one appears. This field used to add USD cents to EUR cents to BDT cents and
   * present the result as a monetary total — it is `null` rather than wrong, and
   * `byCurrency` carries the figures that can be added up.
   */
  totalValueCents: number | null;
  /** The single currency, or `null` when more than one appears in range. */
  currency: string | null;
  /** Per-currency totals — the only figures that are ever additive. */
  byCurrency: CurrencyConversionStats[];
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

  // Attribute only what the slug proves: the ad and its campaign.
  //
  // There used to be a lookup here for "the most recent click on this ad by this user",
  // filtered on `userId: ctx.advertiserId`. Those two ids are different people by
  // definition — `ctx.advertiserId` is the API key's owner, while `Click.userId` is the
  // Telegram user who tapped the ad link in a channel — so the filter could only ever
  // match if the advertiser clicked their own ad. In practice it returned null on every
  // real conversion, and the post and channel were silently dropped from the row while
  // the code read as though it had found them.
  //
  // A slug carries no clicker identity, so there is nothing here to guess with: the
  // click-derived fields stay null and the caller sends the `clickId` from its landing
  // page when it wants per-click, per-post and per-channel attribution. That path is the
  // one above, and it is verified against the campaign's owner.
  return {
    clickId: null,
    adId: ad.id,
    adPostId: null,
    campaignId: ad.campaignId,
    channelId: null,
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

  // Grouped by currency as well as campaign, so nothing is ever summed across currencies.
  // `ConversionEvent.currency` is written per event (the ingest schema defaults it to USD),
  // which means a single advertiser — or a single campaign — can legitimately hold more
  // than one.
  const groups = await prisma.conversionEvent.groupBy({
    by: ['campaignId', 'currency'],
    where,
    _count: { _all: true },
    _sum: { valueCents: true },
  });

  const campaignIds = groups.map((g) => g.campaignId).filter((id): id is string => Boolean(id));
  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: campaignIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(campaigns.map((c) => [c.id, c.name]));

  /** Fold a set of (currency, count, sum) rows into a per-currency list. */
  const foldCurrencies = (
    rows: { currency: string; count: number; sum: number }[],
  ): CurrencyConversionStats[] => {
    const byCurrency = new Map<string, CurrencyConversionStats>();
    for (const row of rows) {
      const entry = byCurrency.get(row.currency) ?? {
        currency: row.currency,
        conversions: 0,
        valueCents: 0,
      };
      entry.conversions += row.count;
      entry.valueCents += row.sum;
      byCurrency.set(row.currency, entry);
    }
    // Ordered by value, then by currency: equal totals are common (a test fixture, or a
    // fresh account), and a response whose order depends on Map insertion would differ
    // between two identical requests.
    return [...byCurrency.values()].sort(
      (a, b) => b.valueCents - a.valueCents || a.currency.localeCompare(b.currency),
    );
  };

  const overall = foldCurrencies(
    groups.map((g) => ({
      currency: g.currency,
      count: g._count._all,
      sum: g._sum.valueCents ?? 0,
    })),
  );

  const byCampaignId = new Map<string, { currency: string; count: number; sum: number }[]>();
  for (const g of groups) {
    if (g.campaignId === null) continue;
    const list = byCampaignId.get(g.campaignId) ?? [];
    list.push({ currency: g.currency, count: g._count._all, sum: g._sum.valueCents ?? 0 });
    byCampaignId.set(g.campaignId, list);
  }

  const byCampaign: CampaignConversionStats[] = [...byCampaignId.entries()]
    .map(([campaignId, rows]) => {
      const byCurrency = foldCurrencies(rows);
      const single = byCurrency.length === 1 ? byCurrency[0] : undefined;
      return {
        campaignId,
        campaignName: nameById.get(campaignId) ?? null,
        conversions: rows.reduce((n, r) => n + r.count, 0),
        // One currency for the whole campaign is the only case where a single figure
        // means anything.
        valueCents: single ? single.valueCents : null,
        currency: single ? single.currency : null,
        byCurrency,
      };
    })
    .sort(
      (a, b) =>
        b.conversions - a.conversions ||
        (b.valueCents ?? 0) - (a.valueCents ?? 0) ||
        a.campaignId.localeCompare(b.campaignId),
    );

  const singleOverall = byCurrencySingleton(overall);

  return {
    conversions: overall.reduce((n, c) => n + c.conversions, 0),
    totalValueCents: singleOverall ? singleOverall.valueCents : null,
    currency: singleOverall ? singleOverall.currency : null,
    byCurrency: overall,
    byCampaign,
  };
}

/** The one entry, when there is exactly one; otherwise undefined. */
function byCurrencySingleton(rows: CurrencyConversionStats[]): CurrencyConversionStats | undefined {
  return rows.length === 1 ? rows[0] : undefined;
}

import { Router } from 'express';
import { prisma } from '../../db/prisma';
import { requirePermission } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import { NotFoundError } from '../../utils/errors';
import { displayName } from '../../utils/format';
import {
  clampDays,
  mergeUserGrowth,
  percentage,
  remainingBudgetCents,
  round2,
  summarizeDeliveryJobs,
  toNumber,
  utcDayKey,
  windowStart,
  type DailyCount,
} from './analyticsExtra.helpers';
import { idParams, respondOk } from './common';

/**
 * Extra, read-only analytics aggregates the admin panel cannot get from the
 * existing revenue-by-day endpoint (spec §7, §39-42).
 *
 * Mounted by the caller at `/api/admin/analytics` (NOT by admin/index.ts — a
 * separate workstream owns that file). Every route here is GET + READ-ONLY and
 * requires the `dashboard.view` permission, exactly like the sibling
 * analytics router.
 *
 * Rules that apply to every aggregation below:
 *  - one query per series, run through `Promise.all` when independent;
 *  - `groupBy`/`aggregate` in the database, never `findMany` + reduce in Node;
 *  - every aggregate is funnelled through `toNumber`/`respondOk` so a `bigint`
 *    can never reach `JSON.stringify` (which throws on BigInt);
 *  - each aggregation carries a cost note + the index it would need at scale.
 */

export const analyticsExtraRouter = Router();

analyticsExtraRouter.use(requirePermission('dashboard.view'));

/** Statuses that mean a campaign made it past review (used by the funnel). */
const CAMPAIGNS_APPROVED_STATUSES = [
  'APPROVED',
  'SCHEDULED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'EXPIRED',
  'SUSPENDED',
] as const;

/**
 * GET /campaigns — campaign counts grouped by status, plus grand totals.
 *
 * Response: `{ byStatus: [{ status, count, budgetTotalCents, budgetSpentCents }],
 *             totals: { count, budgetTotalCents, budgetSpentCents } }`
 *
 * COST: one grouped scan of `campaigns`. `group by status` is served by the
 * existing `@@index([status])`, but the budget columns are not in that index, so
 * Postgres still has to visit the heap for the `SUM`s. That is fine at today's
 * table size; if `campaigns` grows into the millions, add a covering index
 * `@@index([status, budgetTotalCents, budgetSpentCents])` so the sums are
 * index-only.
 */
analyticsExtraRouter.get('/campaigns', async (_req, res, next) => {
  try {
    const groups = await prisma.campaign.groupBy({
      by: ['status'],
      _count: { _all: true },
      _sum: { budgetTotalCents: true, budgetSpentCents: true },
    });

    const byStatus = groups.map((g) => ({
      status: g.status,
      count: g._count._all,
      budgetTotalCents: toNumber(g._sum.budgetTotalCents),
      budgetSpentCents: toNumber(g._sum.budgetSpentCents),
    }));

    const totals = byStatus.reduce(
      (acc, row) => ({
        count: acc.count + row.count,
        budgetTotalCents: acc.budgetTotalCents + row.budgetTotalCents,
        budgetSpentCents: acc.budgetSpentCents + row.budgetSpentCents,
      }),
      { count: 0, budgetTotalCents: 0, budgetSpentCents: 0 },
    );

    respondOk(res, { byStatus, totals });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /delivery?days=30 — delivery-job counts grouped by status for a window,
 * plus `avgAttempts`.
 *
 * Response: `{ byStatus: [{ status, count }], avgAttempts: number, total: number }`
 *
 * `avgAttempts` is derived from the SAME grouped query (`_sum.attempts` /
 * `_count`), so there is no second round-trip.
 *
 * COST: `delivery_jobs` has no index on `created_at`, so the window filter is a
 * sequential scan and the group/sort is done with a hash aggregate. Fine for now;
 * once `delivery_jobs` grows, add `@@index([createdAt])` (or `@@index([status,
 * createdAt])` so the group-by status and the range share one index).
 */
analyticsExtraRouter.get('/delivery', async (req, res, next) => {
  try {
    const days = clampDays(req.query.days);
    const since = windowStart(days);

    const groups = await prisma.deliveryJob.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { attempts: true },
    });

    const byStatus = groups.map((g) => ({ status: g.status, count: g._count._all }));
    const total = byStatus.reduce((sum, row) => sum + row.count, 0);
    const attempts = groups.reduce((sum, g) => sum + toNumber(g._sum.attempts), 0);
    const avgAttempts = total > 0 ? round2(attempts / total) : 0;

    respondOk(res, { byStatus, avgAttempts, total });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /users?days=30 — signup + activity growth over a window.
 *
 * Response: `{ byDay: [{ date, newUsers, publishers, advertisers }] }`
 * (ascending, UTC days, zero-filled — always exactly `days` points).
 *
 * `publishers` / `advertisers` are the new users of that signup day who have at
 * least one channel / campaign, i.e. how many of a day's signups went on to
 * become publishers / advertisers.
 *
 * Prisma's `groupBy` cannot bucket a timestamp by day portably (there is no
 * `date_trunc` in the type-safe API, and `groupBy(by: ['createdAt'])` would
 * group by the full timestamp), so — exactly like `analytics.service.revenueByDay`
 * — ONE raw query per series is used, run together with `Promise.all`.
 *
 * COST: three aggregate scans over `users` restricted to the window (served by
 * the existing `@@index([createdAt])`), each with an `EXISTS` probe into
 * `channels` (`@@index([ownerId])`) / `campaigns` (`@@index([advertiserId,
 * status])`). If `users` grows large, these are bounded by the window so they
 * stay cheap; the `EXISTS` subqueries are index lookups and do not scan.
 */
analyticsExtraRouter.get('/users', async (req, res, next) => {
  try {
    const days = clampDays(req.query.days);
    const since = windowStart(days);

    const [newUserRows, publisherRows, advertiserRows] = await Promise.all([
      prisma.$queryRaw<Array<{ date: Date; count: number }>>`
        SELECT
          date_trunc('day', u."created_at") AS "date",
          CAST(COUNT(*) AS INTEGER) AS "count"
        FROM "users" u
        WHERE u."created_at" >= ${since}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      prisma.$queryRaw<Array<{ date: Date; count: number }>>`
        SELECT
          date_trunc('day', u."created_at") AS "date",
          CAST(COUNT(DISTINCT u."id") AS INTEGER) AS "count"
        FROM "users" u
        WHERE u."created_at" >= ${since}
          AND EXISTS (SELECT 1 FROM "channels" c WHERE c."owner_id" = u."id")
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      prisma.$queryRaw<Array<{ date: Date; count: number }>>`
        SELECT
          date_trunc('day', u."created_at") AS "date",
          CAST(COUNT(DISTINCT u."id") AS INTEGER) AS "count"
        FROM "users" u
        WHERE u."created_at" >= ${since}
          AND EXISTS (SELECT 1 FROM "campaigns" ca WHERE ca."advertiser_id" = u."id")
        GROUP BY 1
        ORDER BY 1 ASC
      `,
    ]);

    const toDaily = (rows: Array<{ date: Date; count: number }>): DailyCount[] =>
      rows.map((row) => ({ date: utcDayKey(row.date), count: toNumber(row.count) }));

    const byDay = mergeUserGrowth(
      days,
      toDaily(newUserRows),
      toDaily(publisherRows),
      toDaily(advertiserRows),
    );

    respondOk(res, { byDay });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /channels — channel counts grouped by status and category, plus totals.
 *
 * Response: `{ byStatus: [{ status, count }], byCategory: [{ category, count }],
 *             totals: { approved, attentionRequired, totalSubscribers } }`
 *
 * `approved` / `attentionRequired` are read straight out of the by-status result
 * (no extra query); only the subscriber sum needs its own aggregate. The three
 * queries are independent and run together.
 *
 * COST: status and category group-bys use `@@index([status])` /
 * `@@index([category])`. `SUM(subscriber_count)` has no index to lean on, so it
 * visits every channel row (or an index-only scan if
 * `@@index([subscriberCount])` — which already exists — is used). All three are
 * O(channels); revisit if the table reaches millions.
 */
analyticsExtraRouter.get('/channels', async (_req, res, next) => {
  try {
    const [statusGroups, categoryGroups, subscriberTotals] = await Promise.all([
      prisma.channel.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.channel.groupBy({ by: ['category'], _count: { _all: true } }),
      prisma.channel.aggregate({ _sum: { subscriberCount: true } }),
    ]);

    const byStatus = statusGroups.map((g) => ({ status: g.status, count: g._count._all }));
    const byCategory = categoryGroups.map((g) => ({ category: g.category, count: g._count._all }));
    const statusCount = (status: string): number =>
      byStatus.find((row) => row.status === status)?.count ?? 0;

    respondOk(res, {
      byStatus,
      byCategory,
      totals: {
        approved: statusCount('APPROVED'),
        attentionRequired: statusCount('ATTENTION_REQUIRED'),
        totalSubscribers: toNumber(subscriberTotals._sum.subscriberCount),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /funnel — the spec §86 delivery loop as lifetime counts.
 *
 * Response: `{ channelsApproved, campaignsCreated, campaignsApproved,
 *             postsScheduled, postsPublished, postsFailed, earningsRows }`
 *
 * Lifetime (not windowed): the stages are timestamped by different events
 * (channel approval, campaign creation, job scheduling, publish, earnings), so a
 * window would compare incomparable cohorts. Counts are one query each, all
 * independent, run with `Promise.all`.
 *
 * Definitions:
 *  - campaignsCreated   — non-house campaigns (platform house ads are not a
 *                         customer action and would distort the loop);
 *  - campaignsApproved  — non-house campaigns past review (see the status list);
 *  - postsScheduled     — delivery-job intents created (one per campaign×channel);
 *  - postsPublished / postsFailed — ad-post rows in that terminal state;
 *  - earningsRows       — publisher earning rows booked.
 *
 * COST: seven `COUNT`s. The status-filtered ones use `@@index([status])`
 * (`channels`, `ad_posts`); the unfiltered totals are index-only scans of the PK
 * (or a full scan). Each is O(table); if any becomes a hot path, a partial index
 * on the terminal statuses keeps the counts index-only.
 */
analyticsExtraRouter.get('/funnel', async (_req, res, next) => {
  try {
    const [
      channelsApproved,
      campaignsCreated,
      campaignsApproved,
      postsScheduled,
      postsPublished,
      postsFailed,
      earningsRows,
    ] = await Promise.all([
      prisma.channel.count({ where: { status: 'APPROVED' } }),
      prisma.campaign.count({ where: { isHouse: false } }),
      prisma.campaign.count({
        where: { isHouse: false, status: { in: [...CAMPAIGNS_APPROVED_STATUSES] } },
      }),
      prisma.deliveryJob.count(),
      prisma.adPost.count({ where: { status: 'PUBLISHED' } }),
      prisma.adPost.count({ where: { status: 'FAILED' } }),
      prisma.publisherEarning.count(),
    ]);

    respondOk(res, {
      channelsApproved,
      campaignsCreated,
      campaignsApproved,
      postsScheduled,
      postsPublished,
      postsFailed,
      earningsRows,
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------
 *  Per-entity detail (§40, §41)
 *
 *  These two endpoints return the `CampaignAnalyticsDetail` /
 *  `ChannelAnalyticsDetail` shapes declared — FROZEN — in
 *  frontend/src/admin/lib/types.ts. Two rules apply to both:
 *
 *   - a rate with a zero denominator is NULL, never 0 (see `percentage`);
 *   - `impressions` is a genuine `count()` on `Impression`, which is written
 *     ONLY by the CPM payout path (§44). A fixed-price campaign/channel really
 *     does have 0 impressions, and we NEVER substitute views, reach or
 *     subscriber count for it.
 * ------------------------------------------------------------- */

/**
 * GET /campaigns/:id — one campaign's budget, delivery and reach.
 *
 * Response: `CampaignAnalyticsDetail`.
 * `:id` is a required non-empty string (zod `idParams`); a missing campaign is a
 * clean 404, never an empty object.
 *
 * `delivery` is ONE `groupBy` over `delivery_jobs` filtered to this campaign,
 * folded into the four buckets by `summarizeDeliveryJobs`. `reach.channels` is a
 * second `groupBy` on `channelId`; see the comment on it for why DeliveryJob (not
 * CampaignTarget / AdPost) is the right relation.
 *
 * COST: `delivery_jobs` is reached through the leftmost `campaignId` of
 * `@@unique([campaignId, channelId, adId, seq])`. `clicks` uses
 * `@@index([campaignId, createdAt])`. Impressions are counted through the `ad`
 * relation (`@@index([campaignId, isActive])`). All four run in parallel.
 */
analyticsExtraRouter.get(
  '/campaigns/:id',
  requirePermission('dashboard.view'),
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const { id } = req.params as { id: string };

      const campaign = await prisma.campaign.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
          startAt: true,
          endAt: true,
          budgetTotalCents: true,
          budgetSpentCents: true,
          budgetReservedCents: true,
          advertiser: { select: { firstName: true, lastName: true, username: true } },
        },
      });
      if (!campaign) throw new NotFoundError('Campaign');

      const [deliveryGroups, channelGroups, impressions, clicks] = await Promise.all([
        prisma.deliveryJob.groupBy({
          by: ['status'],
          where: { campaignId: id },
          _count: { _all: true },
        }),
        /**
         * DISTINCT channels the campaign actually targeted.
         *
         * `DeliveryJob` is the record of "one row per (campaign × channel) intent
         * to publish", written when the campaign is PLANNED — so it captures the
         * channels a campaign really targeted, including auto-targeted ones.
         * `CampaignTarget` holds only EXPLICIT advertiser picks (it misses
         * auto-targeting), and `AdPost` exists only once a post is delivered (it
         * under-counts channels that were targeted but never went out). groupBy
         * returns one row per channel, so `.length` is the distinct count — the
         * rows themselves are never fetched.
         */
        prisma.deliveryJob.groupBy({
          by: ['channelId'],
          where: { campaignId: id },
        }),
        /**
         * Impressions are REAL, never invented (§44). `Impression` rows are only
         * ever written by the CPM payout path, so a fixed-price campaign
         * legitimately has 0 — we do NOT fall back to views / reach / subscribers.
         * There is no `Impression -> AdPost` relation in the schema (only the
         * scalar `adPostId`), but every paid post's `adId` belongs to this
         * campaign, so this is a genuine `count()` on `impressions`.
         */
        prisma.impression.count({ where: { ad: { campaignId: id } } }),
        prisma.click.count({ where: { campaignId: id } }),
      ]);

      const { scheduled, published, failed, cancelled } = summarizeDeliveryJobs(
        deliveryGroups.map((g) => ({ status: g.status, count: g._count._all })),
      );

      respondOk(res, {
        campaign: {
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          advertiserName: displayName(campaign.advertiser),
          createdAt: campaign.createdAt,
          startAt: campaign.startAt,
          endAt: campaign.endAt,
        },
        budget: {
          totalCents: campaign.budgetTotalCents,
          spentCents: campaign.budgetSpentCents,
          reservedCents: campaign.budgetReservedCents,
          remainingCents: remainingBudgetCents(
            campaign.budgetTotalCents,
            campaign.budgetSpentCents,
            campaign.budgetReservedCents,
          ),
        },
        delivery: {
          scheduled,
          published,
          failed,
          cancelled,
          // null when nothing has run — a 0% here would read as a real measurement.
          successRatePct: percentage(published, published + failed),
        },
        reach: {
          channels: channelGroups.length,
          impressions,
          clicks,
          // null when impressions is 0 (a fixed-price campaign) — not a fake 0%.
          ctrPct: percentage(clicks, impressions),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /channels/:id — one channel's delivery, performance and reach.
 *
 * Response: `ChannelAnalyticsDetail`.
 * `:id` is a required non-empty string (zod `idParams`); a missing channel is a
 * clean 404, never an empty object.
 *
 * `performance` reuses the SAME grouped-earnings shape as
 * `admin.service.summarizeEarnings` — one `groupBy` on `publisher_earnings.status`
 * with summed gross / net / platform fee — scoped by `channelId`, so this screen
 * and the user dossier cannot drift apart.
 *
 * COST: `delivery_jobs` (`@@index([channelId])`) and `publisher_earnings`
 * (`@@index([channelId])`) are both indexed by channel; `clicks` too. Impressions
 * have no direct channel link in the schema, so they are counted with one
 * DB-side subquery (see below). All four run in parallel.
 */
analyticsExtraRouter.get(
  '/channels/:id',
  requirePermission('dashboard.view'),
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const { id } = req.params as { id: string };

      const channel = await prisma.channel.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          username: true,
          status: true,
          subscriberCount: true,
          avgViews: true,
          owner: { select: { firstName: true, lastName: true, username: true } },
        },
      });
      if (!channel) throw new NotFoundError('Channel');

      const [deliveryGroups, earningGroups, impressionRows, clicks] = await Promise.all([
        prisma.deliveryJob.groupBy({
          by: ['status'],
          where: { channelId: id },
          _count: { _all: true },
        }),
        prisma.publisherEarning.groupBy({
          by: ['status'],
          where: { channelId: id },
          _sum: { grossCents: true, netCents: true, platformFeeCents: true },
          _count: { _all: true },
        }),
        /**
         * Impressions (spec §44) are REAL `Impression` rows, written only by the
         * CPM payout path — never derived from views / reach / subscribers. The
         * schema has no `Impression -> AdPost` relation (only the scalar
         * `ad_post_id`) and we may not add one (no migration), so the channel's
         * impressions are counted with a DB-side subquery over the channel's ad
         * posts: a genuine `COUNT` on `impressions`, zero rows fetched, no JS
         * tallying. The COUNT is bigint in Postgres, hence `toNumber` below.
         */
        prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS "count"
          FROM "impressions" i
          WHERE i."ad_post_id" IN (
            SELECT p."id" FROM "ad_posts" p WHERE p."channel_id" = ${id}
          )
        `,
        prisma.click.count({ where: { channelId: id } }),
      ]);

      const { scheduled, published, failed } = summarizeDeliveryJobs(
        deliveryGroups.map((g) => ({ status: g.status, count: g._count._all })),
      );
      const impressions = toNumber(impressionRows[0]?.count);

      const sumOf = (pick: (g: (typeof earningGroups)[number]) => number | null): number =>
        earningGroups.reduce((acc, g) => acc + (pick(g) ?? 0), 0);

      respondOk(res, {
        channel: {
          id: channel.id,
          title: channel.title,
          username: channel.username,
          status: channel.status,
          ownerName: displayName(channel.owner),
          subscriberCount: channel.subscriberCount,
          avgViews: channel.avgViews,
        },
        delivery: {
          scheduled,
          published,
          failed,
          // null when nothing has run — a 0% here would read as a real measurement.
          successRatePct: percentage(published, published + failed),
        },
        performance: {
          posts: earningGroups.reduce((acc, g) => acc + g._count._all, 0),
          grossCents: sumOf((g) => g._sum.grossCents),
          netCents: sumOf((g) => g._sum.netCents),
          platformFeeCents: sumOf((g) => g._sum.platformFeeCents),
        },
        reach: {
          impressions,
          clicks,
          // null when impressions is 0 (e.g. a FIXED-earning channel) — not a fake 0%.
          ctrPct: percentage(clicks, impressions),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

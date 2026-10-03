import { Router } from 'express';
import { AdPostStatus, BlocklistScope } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { prisma } from '../../db/prisma';
import { recordAudit } from '../../services/audit.service';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { buildPaginated, getPagination } from '../../utils/pagination';
import { adminUserId, idParams, respondOk } from './common';

/**
 * Admin "Blocked channels" + "Blocked ad posts" surface (spec §46–§48).
 *
 * READ `backend/prisma/schema.prisma` BEFORE CHANGING THIS FILE. Two premises in
 * the spec/gap-analysis do not match the schema, and this file is written against
 * the SCHEMA, not the prose:
 *
 *  1. `PublisherBlocklist` is NOT a GLOBAL / USER / CHANNEL admin blocklist. It is
 *     a publisher's OWN blocklist, keyed by channel, and its `BlocklistScope` enum
 *     is ADVERTISER | CAMPAIGN | CATEGORY | DOMAIN. There is no CHANNEL scope and
 *     there is NO `reason` column (the only free-text field is `label`). So
 *     "block a channel" is expressed, as faithfully as the model allows, as
 *     adding a blocklist entry ON that channel; `reason` is stored in `label`.
 *  2. `AdPostStatus` has NO `REMOVED` member. It has DELETED and REJECTED. There
 *     is no `blocked_ads` table. An ad-level "block" therefore reuses the real
 *     removed state (`status = DELETED`, the same value moderation REMOVE writes),
 *     records the reason in the real `errorMessage` column under a marker, and
 *     writes an audit row. See the ad routes below for the exact contract.
 *
 * Mounted by the caller (this file is intentionally NOT wired into index.ts) —
 * the intended mount is `/api/admin/blocked`.
 *
 * Every mutation is audited via `recordAudit` and gated with `fraud.manage`.
 */

export const blockedRouter = Router();

/** The permission every route below requires (unchanged 22-key catalogue). */
const BLOCKED_PERMISSION = 'fraud.manage';

/* ------------------------------------------------------------------
 *  Blocked channels — PublisherBlocklist
 * ------------------------------------------------------------------ */

const CHANNEL_SELECT = {
  id: true,
  title: true,
  username: true,
  status: true,
} satisfies Prisma.ChannelSelect;

type BlockedChannelRow = Prisma.PublisherBlocklistGetPayload<{
  include: { channel: { select: typeof CHANNEL_SELECT } };
}>;

function toBlockedChannelItem(row: BlockedChannelRow) {
  return {
    /** Blocklist row id — this is the id `DELETE /channels/:id` takes. */
    id: row.id,
    channelId: row.channelId,
    channelTitle: row.channel.title,
    channelUsername: row.channel.username,
    channelStatus: row.channel.status,
    scope: row.scope,
    value: row.value,
    /** No `reason` column exists on PublisherBlocklist; `label` is where it lives. */
    reason: row.label,
    createdAt: row.createdAt,
  };
}

/**
 * Mirror of the normalisation in `blocklist.service.ts` so an admin entry lands
 * with the same shape a publisher entry would (both then hit the same
 * `@@unique([channelId, scope, value])` and are therefore idempotent).
 */
function normalizeValue(scope: BlocklistScope, raw: string): string {
  const trimmed = raw.trim();
  switch (scope) {
    case 'DOMAIN':
      return trimmed
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/+$/, '');
    case 'CATEGORY':
      return trimmed.toUpperCase();
    case 'ADVERTISER':
    case 'CAMPAIGN':
      return trimmed.toLowerCase();
  }
}

const blockedChannelsQuery = paginationSchema.extend({
  search: z.string().max(100).trim().optional(),
});

/**
 * List blocklist entries, joined to the channel they belong to.
 *
 * NOTE: this lists the real model — PublisherBlocklist rows, each of which IS
 * channel-scoped (`channelId`) but carries a scope of ADVERTISER / CAMPAIGN /
 * CATEGORY / DOMAIN. There is no CHANNEL-scope row to list.
 */
blockedRouter.get(
  '/channels',
  requirePermission(BLOCKED_PERMISSION),
  validate({ query: blockedChannelsQuery }),
  async (req, res, next) => {
    try {
      const query = req.query as unknown as z.infer<typeof blockedChannelsQuery>;
      const p = getPagination(query);

      const where: Prisma.PublisherBlocklistWhereInput = query.search
        ? {
            OR: [
              { value: { contains: query.search, mode: 'insensitive' } },
              { label: { contains: query.search, mode: 'insensitive' } },
              { channel: { title: { contains: query.search, mode: 'insensitive' } } },
              { channel: { username: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {};

      const [total, rows] = await Promise.all([
        prisma.publisherBlocklist.count({ where }),
        prisma.publisherBlocklist.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: p.skip,
          take: p.take,
          include: { channel: { select: CHANNEL_SELECT } },
        }),
      ]);

      respondOk(res, buildPaginated(rows.map(toBlockedChannelItem), total, p));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Body for adding a block.
 *
 * The spec's `{ channelId, reason }` is NOT enough to write a PublisherBlocklist
 * row: `scope` and `value` are both NOT NULL and are the unique key. `scope` is
 * validated against the real enum; `reason` (3..500) is stored in `label`.
 */
const blockChannelSchema = z.object({
  channelId: z.string().min(1),
  scope: z.nativeEnum(BlocklistScope),
  value: z.string().trim().min(1).max(200),
  reason: z
    .string()
    .trim()
    .min(3, 'A reason of at least 3 characters is required')
    .max(500, 'The reason must be at most 500 characters'),
});

/**
 * Add a blocklist entry on a channel. Idempotent: re-blocking the SAME
 * (channel, scope, value) returns 200 with the (re-affirmed) row — it is an
 * upsert on the natural key, never a 409.
 */
blockedRouter.post(
  '/channels',
  requirePermission(BLOCKED_PERMISSION),
  validate({ body: blockChannelSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof blockChannelSchema>;
      const key = {
        channelId: body.channelId,
        scope: body.scope,
        value: normalizeValue(body.scope, body.value),
      };

      const channel = await prisma.channel.findUnique({
        where: { id: body.channelId },
        select: { id: true, title: true },
      });
      if (!channel) throw new NotFoundError('Channel');

      const existing = await prisma.publisherBlocklist.findUnique({
        where: { channelId_scope_value: key },
      });

      const row = await prisma.publisherBlocklist.upsert({
        where: { channelId_scope_value: key },
        update: { label: body.reason },
        create: { ...key, label: body.reason },
        include: { channel: { select: CHANNEL_SELECT } },
      });

      await recordAudit({
        actorId: adminUserId(req),
        actorType: 'ADMIN',
        action: existing ? 'CHANNEL_BLOCK_REAFFIRMED' : 'CHANNEL_BLOCK_ADDED',
        targetType: 'CHANNEL',
        targetId: row.channelId,
        oldValue: existing
          ? { scope: existing.scope, value: existing.value, reason: existing.label }
          : null,
        newValue: { scope: row.scope, value: row.value, reason: row.label },
      });

      respondOk(res, toBlockedChannelItem(row));
    } catch (err) {
      next(err);
    }
  },
);

/** Lift a block by blocklist row id. */
blockedRouter.delete(
  '/channels/:id',
  requirePermission(BLOCKED_PERMISSION),
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const entry = await prisma.publisherBlocklist.findUnique({ where: { id: req.params.id } });
      if (!entry) throw new NotFoundError('Blocklist entry');

      await prisma.publisherBlocklist.delete({ where: { id: entry.id } });

      await recordAudit({
        actorId: adminUserId(req),
        actorType: 'ADMIN',
        action: 'CHANNEL_BLOCK_REMOVED',
        targetType: 'CHANNEL',
        targetId: entry.channelId,
        oldValue: { scope: entry.scope, value: entry.value, reason: entry.label },
        newValue: null,
      });

      respondOk(res, { id: entry.id, deleted: true });
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------------------------
 *  Blocked ad posts — AdPost
 * ------------------------------------------------------------------ */

/**
 * An ad post's "blocked" state is the DELETED status.
 *
 * WHICH STATES THIS ENDPOINT LISTS (spec asked us to say so explicitly):
 *   - AdPostStatus.DELETED  — the exact value moderation REMOVE writes, and what
 *                             `POST /ads/:id/block` sets below; and
 *   - AdPostStatus.REJECTED — a post the platform refused.
 *   - PLUS every post whose channel currently has ANY PublisherBlocklist entry
 *     (schema has no per-ad block table, so "channel is on the blocklist" is the
 *     honest second source of "not deliverable").
 *
 * There is NO `REMOVED` member in AdPostStatus and NO `blocked_ads` table; this
 * is the "deliverable = false" definition the spec fallback calls for.
 */
const NON_DELIVERABLE_AD_STATUSES: AdPostStatus[] = [AdPostStatus.DELETED, AdPostStatus.REJECTED];

/**
 * Marker written into `AdPost.errorMessage` when an admin blocks a post. There is
 * no ad-block table and no dedicated reason column, so the reason is stored here
 * (prefixed) purely so the list can show it without an N+1 audit lookup; the
 * authoritative record is still the `AD_POST_BLOCKED` audit row.
 */
const ADMIN_BLOCK_MARKER = 'BLOCKED_BY_ADMIN:';

const AD_CAMPAIGN_SELECT = { name: true } satisfies Prisma.CampaignSelect;
const AD_CHANNEL_SELECT = { title: true } satisfies Prisma.ChannelSelect;

type BlockedAdRow = Prisma.AdPostGetPayload<{
  include: { campaign: { select: typeof AD_CAMPAIGN_SELECT }; channel: { select: typeof AD_CHANNEL_SELECT } };
}>;

function deriveAdReason(row: { status: AdPostStatus; errorMessage: string | null }): string {
  const message = row.errorMessage?.trim() ?? '';
  if (message.startsWith(ADMIN_BLOCK_MARKER)) {
    return message.slice(ADMIN_BLOCK_MARKER.length).trim() || 'Blocked by admin';
  }
  if (message) return message;
  if (row.status === AdPostStatus.DELETED) return 'Removed by moderation';
  if (row.status === AdPostStatus.REJECTED) return 'Rejected';
  return 'Channel is on the blocklist';
}

function toBlockedAdItem(row: BlockedAdRow) {
  return {
    id: row.id,
    campaignName: row.campaign?.name ?? (row.houseAdId ? 'House ad' : null),
    channelTitle: row.channel.title,
    status: row.status,
    reason: deriveAdReason(row),
    createdAt: row.createdAt,
  };
}

const blockedAdsQuery = paginationSchema.extend({
  search: z.string().max(100).trim().optional(),
});

/** Paginated list of ad posts that are not in a deliverable state (see above). */
blockedRouter.get(
  '/ads',
  requirePermission(BLOCKED_PERMISSION),
  validate({ query: blockedAdsQuery }),
  async (req, res, next) => {
    try {
      const query = req.query as unknown as z.infer<typeof blockedAdsQuery>;
      const p = getPagination(query);

      const blocked = await prisma.publisherBlocklist.findMany({
        distinct: ['channelId'],
        select: { channelId: true },
      });
      const blockedChannelIds = blocked.map((row) => row.channelId);

      const or: Prisma.AdPostWhereInput[] = [{ status: { in: NON_DELIVERABLE_AD_STATUSES } }];
      if (blockedChannelIds.length > 0) or.push({ channelId: { in: blockedChannelIds } });

      const and: Prisma.AdPostWhereInput[] = [];
      if (query.search) {
        and.push({
          OR: [
            { campaign: { name: { contains: query.search, mode: 'insensitive' } } },
            { channel: { title: { contains: query.search, mode: 'insensitive' } } },
          ],
        });
      }

      const where: Prisma.AdPostWhereInput = { OR: or, ...(and.length > 0 ? { AND: and } : {}) };

      const [total, rows] = await Promise.all([
        prisma.adPost.count({ where }),
        prisma.adPost.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: p.skip,
          take: p.take,
          include: { campaign: { select: AD_CAMPAIGN_SELECT }, channel: { select: AD_CHANNEL_SELECT } },
        }),
      ]);

      respondOk(res, buildPaginated(rows.map(toBlockedAdItem), total, p));
    } catch (err) {
      next(err);
    }
  },
);

/** A block reason: required, 3..500 characters. */
const blockAdSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'A reason of at least 3 characters is required')
    .max(500, 'The reason must be at most 500 characters'),
});

/**
 * Block an ad post: set the REAL removed state (`status = DELETED`, the value
 * moderation REMOVE uses), stamp the reason into `errorMessage` under the
 * marker, and audit. Idempotent — a post already blocked by an admin returns 200
 * with the existing row.
 */
blockedRouter.post(
  '/ads/:id/block',
  requirePermission(BLOCKED_PERMISSION),
  validate({ params: idParams, body: blockAdSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof blockAdSchema>;
      const post = await prisma.adPost.findUnique({
        where: { id: req.params.id },
        select: { id: true, status: true, errorMessage: true },
      });
      if (!post) throw new NotFoundError('Ad post');

      const include = {
        campaign: { select: AD_CAMPAIGN_SELECT },
        channel: { select: AD_CHANNEL_SELECT },
      } satisfies Prisma.AdPostInclude;

      // Already blocked by an admin → idempotent 200 with the existing row.
      if (post.errorMessage?.startsWith(ADMIN_BLOCK_MARKER)) {
        const existing = await prisma.adPost.findUniqueOrThrow({
          where: { id: post.id },
          include,
        });
        respondOk(res, toBlockedAdItem(existing));
        return;
      }

      const updated = await prisma.adPost.update({
        where: { id: post.id },
        data: {
          status: AdPostStatus.DELETED,
          deletedAt: new Date(),
          errorMessage: `${ADMIN_BLOCK_MARKER} ${body.reason}`,
        },
        include,
      });

      await recordAudit({
        actorId: adminUserId(req),
        actorType: 'ADMIN',
        action: 'AD_POST_BLOCKED',
        targetType: 'AD_POST',
        targetId: post.id,
        oldValue: { status: post.status, errorMessage: post.errorMessage },
        newValue: { status: AdPostStatus.DELETED, reason: body.reason },
      });

      respondOk(res, toBlockedAdItem(updated));
    } catch (err) {
      next(err);
    }
  },
);

function isAdPostStatus(value: string): value is AdPostStatus {
  return (Object.values(AdPostStatus) as string[]).includes(value);
}

/**
 * Lift an admin block: restore the status the post had BEFORE it was blocked
 * (read from the `AD_POST_BLOCKED` audit `oldValue`), clear the marker, and
 * audit. Only posts carrying the marker are unblockable, so a genuine moderation
 * removal is never silently reversed.
 */
blockedRouter.delete(
  '/ads/:id/block',
  requirePermission(BLOCKED_PERMISSION),
  validate({ params: idParams }),
  async (req, res, next) => {
    try {
      const post = await prisma.adPost.findUnique({
        where: { id: req.params.id },
        select: { id: true, status: true, errorMessage: true },
      });
      if (!post) throw new NotFoundError('Ad post');
      if (!post.errorMessage?.startsWith(ADMIN_BLOCK_MARKER)) {
        throw new ConflictError('This ad post is not blocked by an administrator');
      }

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'AD_POST_BLOCKED', targetType: 'AD_POST', targetId: post.id },
        orderBy: { createdAt: 'desc' },
      });
      const previous = (audit?.oldValue ?? null) as { status?: string; errorMessage?: string | null } | null;

      // Default to QUEUED (the AdPost default) only when the audit row is gone.
      const restoreStatus =
        previous?.status && isAdPostStatus(previous.status) ? previous.status : AdPostStatus.QUEUED;

      const updated = await prisma.adPost.update({
        where: { id: post.id },
        data: {
          status: restoreStatus,
          deletedAt: null,
          errorMessage: previous?.errorMessage ?? null,
        },
        include: {
          campaign: { select: AD_CAMPAIGN_SELECT },
          channel: { select: AD_CHANNEL_SELECT },
        },
      });

      await recordAudit({
        actorId: adminUserId(req),
        actorType: 'ADMIN',
        action: 'AD_POST_UNBLOCKED',
        targetType: 'AD_POST',
        targetId: post.id,
        oldValue: { status: AdPostStatus.DELETED },
        newValue: { status: restoreStatus },
      });

      respondOk(res, toBlockedAdItem(updated));
    } catch (err) {
      next(err);
    }
  },
);

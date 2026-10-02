import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { prisma } from '../../db/prisma';
import { childLogger } from '../../config/logger';
import { displayName } from '../../utils/format';
import { respondOk } from './common';

/**
 * Admin global search (spec section 64).
 *
 * One query, five entities, one flat result shape. The panel renders the same
 * row whether the hit is a user, a channel, a campaign, a transaction or a
 * ticket, so the type only drives the badge and the link target.
 *
 * COST — every Prisma `contains` below compiles to `LIKE '%term%'` (or ILIKE).
 * A LEADING wildcard cannot use a B-tree index, so PostgreSQL must visit every
 * matching row: the scan is O(rows), not O(log n). Two things keep it bounded
 * here:
 *   - `q` is required to be at least 2 characters, so the shortest, most
 *     selective-free terms (1 char) are rejected up front;
 *   - every entity is capped with a `take`/`LIMIT` of `limit`, so the executor
 *     stops once it has `limit` hits and the response size is bounded.
 * A `take` does NOT make the worst case cheap: a term that matches nothing still
 * scans the whole column. To scale this past a few hundred thousand rows the
 * substring predicates need an index that supports middle-anchored matches — a
 * pg_trgm GIN index (`gin_trgm_ops`) on each searched text column, or a
 * maintained tsvector full-text column — not another `take`.
 */
export const searchRouter = Router();

const log = childLogger('admin.search');

/** Fixed entity order — keeps the concatenated result list stable. */
const SEARCH_ENTITIES = ['users', 'channels', 'campaigns', 'transactions', 'tickets'] as const;

export const searchQuerySchema = z.object({
  q: z.string().min(2).max(64),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export type SearchResultType = 'USER' | 'CHANNEL' | 'CAMPAIGN' | 'TRANSACTION' | 'TICKET';

/** One flat row, whatever the entity. */
export interface SearchResult {
  type: SearchResultType;
  id: string;
  label: string;
  sublabel: string;
  href: string;
}

/** Escape LIKE wildcards so a search term matches literally. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Users: username, first/last name, and Telegram id.
 *
 * `telegramId` is a BigInt column, which Prisma cannot `contains`-match. This
 * reuses the raw cast-to-text technique from `admin.service.listUsersAdmin`;
 * the extra `LIMIT` keeps the raw scan bounded exactly like the Prisma `take`.
 */
async function searchUsers(q: string, limit: number): Promise<SearchResult[]> {
  const like = `%${escapeLike(q)}%`;
  const telegramMatches = await prisma.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "users" WHERE CAST("telegram_id" AS TEXT) LIKE ${like} ESCAPE '\\' LIMIT ${limit}`,
  );
  const telegramIds = telegramMatches.map((r) => r.id);

  const rows = await prisma.user.findMany({
    where: {
      OR: [
        { username: { contains: q, mode: 'insensitive' } },
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        ...(telegramIds.length > 0 ? [{ id: { in: telegramIds } }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, username: true, firstName: true, lastName: true, telegramId: true },
  });

  return rows.map((u) => ({
    type: 'USER' as const,
    id: u.id,
    label: displayName(u),
    // BigInt column — stringify explicitly so nothing unsafish reaches the wire.
    sublabel: u.username ? `@${u.username} · id ${u.telegramId.toString()}` : `id ${u.telegramId.toString()}`,
    href: `/admin/users/${u.id}`,
  }));
}

/** Channels: title and @username. */
async function searchChannels(q: string, limit: number): Promise<SearchResult[]> {
  const rows = await prisma.channel.findMany({
    where: {
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { username: { contains: q, mode: 'insensitive' } },
      ],
    },
    orderBy: { subscriberCount: 'desc' },
    take: limit,
    select: { id: true, title: true, username: true, subscriberCount: true },
  });

  return rows.map((c) => ({
    type: 'CHANNEL' as const,
    id: c.id,
    label: c.title,
    sublabel: c.username ? `@${c.username} · ${c.subscriberCount} subs` : `${c.subscriberCount} subs`,
    href: `/admin/channels?search=${encodeURIComponent(c.username ?? c.title)}`,
  }));
}

/** Campaigns: name. */
async function searchCampaigns(q: string, limit: number): Promise<SearchResult[]> {
  const rows = await prisma.campaign.findMany({
    where: { name: { contains: q, mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, name: true, status: true },
  });

  return rows.map((c) => ({
    type: 'CAMPAIGN' as const,
    id: c.id,
    label: c.name,
    sublabel: c.status,
    href: `/admin/campaigns?search=${encodeURIComponent(c.name)}`,
  }));
}

/** Transactions: reference (equals or contains). */
async function searchTransactions(q: string, limit: number): Promise<SearchResult[]> {
  const rows = await prisma.transaction.findMany({
    where: { reference: { contains: q, mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, reference: true, type: true, amountCents: true, currency: true },
  });

  return rows.map((t) => ({
    type: 'TRANSACTION' as const,
    id: t.id,
    label: t.reference,
    sublabel: `${t.type} · ${(t.amountCents / 100).toFixed(2)} ${t.currency}`,
    href: `/admin/finance/ledger?search=${encodeURIComponent(t.reference)}`,
  }));
}

/** Support tickets: ticketNo (equals) and subject. */
async function searchTickets(q: string, limit: number): Promise<SearchResult[]> {
  const rows = await prisma.supportTicket.findMany({
    where: {
      OR: [
        { ticketNo: { equals: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
      ],
    },
    orderBy: { lastMessageAt: 'desc' },
    take: limit,
    select: { id: true, ticketNo: true, subject: true, status: true },
  });

  return rows.map((t) => ({
    type: 'TICKET' as const,
    id: t.id,
    label: t.ticketNo,
    sublabel: `${t.subject} · ${t.status}`,
    href: `/admin/support?search=${encodeURIComponent(t.ticketNo)}`,
  }));
}

/** Cross-entity admin search. Always returns `{ results: [...] }`, never throws per entity. */
searchRouter.get(
  '/',
  requirePermission('dashboard.view'),
  validate({ query: searchQuerySchema }),
  async (req, res, next) => {
    try {
      const { q, limit } = req.query as unknown as z.infer<typeof searchQuerySchema>;

      // allSettled, not all: one entity having a bad day (an index missing, a
      // lock timeout) must degrade the result list, not blank the whole search.
      const settled = await Promise.allSettled([
        searchUsers(q, limit),
        searchChannels(q, limit),
        searchCampaigns(q, limit),
        searchTransactions(q, limit),
        searchTickets(q, limit),
      ]);

      const results: SearchResult[] = [];
      settled.forEach((outcome, i) => {
        if (outcome.status === 'fulfilled') {
          results.push(...outcome.value);
        } else {
          log.warn(
            { entity: SEARCH_ENTITIES[i], err: outcome.reason, q },
            'admin search: entity query failed',
          );
        }
      });

      respondOk(res, { results });
    } catch (err) {
      next(err);
    }
  },
);

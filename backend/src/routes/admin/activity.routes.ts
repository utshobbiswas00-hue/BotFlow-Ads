import { Router } from 'express';
import { requirePermission } from '../../middleware/adminAuth';
import { prisma } from '../../db/prisma';
import { respondOk } from './common';

/**
 * Cross-entity activity stream (spec §65).
 *
 * This is a COMPUTED VIEW, not a stored event log — and there should not be one.
 * Every entry is derived from a row that already exists, so the stream can never
 * fall behind the tables it summarises and there is no read state to maintain.
 *
 * Each source contributes one `findMany({ take, orderBy: { createdAt: 'desc' } })`.
 * They run through `Promise.allSettled`, so ONE failing source degrades the feed
 * (that source goes missing) instead of blanking the whole page. The results are
 * merged and sorted in JS, then sliced to the requested limit.
 *
 * Privacy: only display names / titles / amounts are surfaced. Telegram ids and
 * email addresses are never selected, so they cannot leak into a label or detail.
 *
 * Mounted by the caller at `/api/admin/activity` (NOT wired into index.ts).
 */
export const activityRouter = Router();

activityRouter.use(requirePermission('dashboard.view'));

export interface ActivityItem {
  /** NEW_USER | NEW_CHANNEL | CAMPAIGN_CREATED | ... */
  kind: string;
  id: string;
  label: string;
  detail: string | null;
  /** A real panel route when one exists, else null. */
  href: string | null;
  createdAt: string;
}

export interface ActivityFeed {
  items: ActivityItem[];
  generatedAt: string;
}

export const ACTIVITY_DEFAULT_LIMIT = 60;
export const ACTIVITY_MAX_LIMIT = 200;

/** Parse `?limit=`, default 60, hard-capped at 200. */
export function parseActivityLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return ACTIVITY_DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), ACTIVITY_MAX_LIMIT);
}

/** Stable newest-first merge. ISO-8601 strings compare chronologically. */
export function mergeActivityItems(items: ActivityItem[], limit: number): ActivityItem[] {
  return [...items]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/** A user-facing display name. Never the telegram id or email. */
function displayName(u: {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
}): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return full || u.username || 'User';
}

function formatCents(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

async function recentUsers(take: number): Promise<ActivityItem[]> {
  const rows = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, firstName: true, lastName: true, username: true, createdAt: true },
  });
  return rows.map((u) => ({
    kind: 'NEW_USER',
    id: u.id,
    label: displayName(u),
    detail: null,
    href: `/admin/users/${u.id}`,
    createdAt: u.createdAt.toISOString(),
  }));
}

async function recentChannels(take: number): Promise<ActivityItem[]> {
  const rows = await prisma.channel.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, title: true, category: true, createdAt: true },
  });
  return rows.map((c) => ({
    kind: 'NEW_CHANNEL',
    id: c.id,
    label: c.title,
    detail: c.category,
    href: '/admin/channels',
    createdAt: c.createdAt.toISOString(),
  }));
}

/**
 * Campaigns created, approved and rejected. A single row can yield more than one
 * entry: the creation at `createdAt`, and a review event at `reviewedAt` when the
 * campaign has been approved or rejected.
 */
async function recentCampaigns(take: number): Promise<ActivityItem[]> {
  const rows = await prisma.campaign.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, name: true, status: true, createdAt: true, reviewedAt: true },
  });

  const items: ActivityItem[] = [];
  for (const c of rows) {
    items.push({
      kind: 'CAMPAIGN_CREATED',
      id: c.id,
      label: c.name,
      detail: null,
      href: '/admin/campaigns',
      createdAt: c.createdAt.toISOString(),
    });
    if (c.reviewedAt && c.status === 'APPROVED') {
      items.push({
        kind: 'CAMPAIGN_APPROVED',
        id: c.id,
        label: c.name,
        detail: null,
        href: '/admin/campaigns',
        createdAt: c.reviewedAt.toISOString(),
      });
    } else if (c.reviewedAt && c.status === 'REJECTED') {
      items.push({
        kind: 'CAMPAIGN_REJECTED',
        id: c.id,
        label: c.name,
        detail: null,
        href: '/admin/campaigns',
        createdAt: c.reviewedAt.toISOString(),
      });
    }
  }
  return items;
}

async function recentAdPosts(take: number): Promise<ActivityItem[]> {
  const rows = await prisma.adPost.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      publishedAt: true,
      createdAt: true,
      campaign: { select: { name: true } },
      channel: { select: { title: true } },
    },
  });
  return rows.map((p) => ({
    kind: 'AD_POST_PUBLISHED',
    id: p.id,
    label: p.campaign?.name ?? p.channel.title,
    detail: p.channel.title,
    href: '/admin/delivery',
    createdAt: (p.publishedAt ?? p.createdAt).toISOString(),
  }));
}

async function recentDeposits(take: number): Promise<ActivityItem[]> {
  const rows = await prisma.deposit.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      amountCents: true,
      currency: true,
      method: true,
      status: true,
      createdAt: true,
    },
  });
  return rows.map((d) => ({
    kind: 'DEPOSIT',
    id: d.id,
    label: formatCents(d.amountCents, d.currency),
    detail: `${d.method} · ${d.status}`,
    href: '/admin/finance/deposits',
    createdAt: d.createdAt.toISOString(),
  }));
}

async function recentWithdrawals(take: number): Promise<ActivityItem[]> {
  const rows = await prisma.withdrawal.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      amountCents: true,
      currency: true,
      method: true,
      status: true,
      createdAt: true,
    },
  });
  return rows.map((w) => ({
    kind: 'WITHDRAWAL',
    id: w.id,
    label: formatCents(w.amountCents, w.currency),
    detail: `${w.method} · ${w.status}`,
    href: '/admin/finance/withdrawals',
    createdAt: w.createdAt.toISOString(),
  }));
}

async function recentReports(take: number): Promise<ActivityItem[]> {
  const rows = await prisma.report.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, reason: true, status: true, createdAt: true },
  });
  return rows.map((r) => ({
    kind: 'REPORT',
    id: r.id,
    label: `Report: ${r.reason}`,
    detail: r.status,
    href: '/admin/moderation',
    createdAt: r.createdAt.toISOString(),
  }));
}

async function recentFraudEvents(take: number): Promise<ActivityItem[]> {
  const rows = await prisma.fraudEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, type: true, severity: true, resolved: true, createdAt: true },
  });
  return rows.map((f) => ({
    kind: 'FRAUD_EVENT',
    id: f.id,
    label: `Fraud signal: ${f.type}`,
    detail: f.resolved ? `${f.severity} · resolved` : f.severity,
    href: '/admin/moderation',
    createdAt: f.createdAt.toISOString(),
  }));
}

/**
 * Query every source in parallel, drop the ones that failed, and return the
 * newest-first slice. Exported (and Prisma is mockable) so the merge and the
 * one-source-fails behaviour are unit-testable without a database.
 */
export async function buildActivityFeed(limit: number): Promise<ActivityItem[]> {
  const take = limit;
  const settled = await Promise.allSettled([
    recentUsers(take),
    recentChannels(take),
    recentCampaigns(take),
    recentAdPosts(take),
    recentDeposits(take),
    recentWithdrawals(take),
    recentReports(take),
    recentFraudEvents(take),
  ]);

  const items = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  return mergeActivityItems(items, limit);
}

activityRouter.get('/', async (req, res, next) => {
  try {
    const limit = parseActivityLimit(req.query.limit);
    const items = await buildActivityFeed(limit);
    respondOk(res, { items, generatedAt: new Date().toISOString() } satisfies ActivityFeed);
  } catch (err) {
    next(err);
  }
});

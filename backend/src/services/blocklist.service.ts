/**
 * Publisher blocklist service.
 *
 * A channel owner can block, per-channel:
 *   - a specific advertiser (by user id),
 *   - a specific campaign (by id),
 *   - an entire advertising category,
 *   - a destination domain.
 *
 * Values are normalised on write so lookups are exact string comparisons:
 *   DOMAIN      -> lowercase, scheme stripped, leading "www." stripped
 *   CATEGORY    -> uppercase, must be a valid ChannelCategory
 *   ADVERTISER  -> trimmed, lowercased
 *   CAMPAIGN    -> trimmed, lowercased
 *
 * Every block decision returns a human-readable reason — nothing is ever
 * blocked silently.
 */
import { BlocklistScope, ChannelCategory } from '@prisma/client';
import { prisma } from '../db/prisma';
import { NotFoundError, ValidationError } from '../utils/errors';
import { recordAudit } from './audit.service';
import { assertChannelOwner } from './channel.service';

const ALL_SCOPES: readonly BlocklistScope[] = [
  'ADVERTISER',
  'CAMPAIGN',
  'CATEGORY',
  'DOMAIN',
] as const;

const ALL_CATEGORIES: readonly string[] = Object.values(ChannelCategory);

/** Lowercase, strip scheme (https://, t.me:...) and a leading "www." */
function normalizeDomain(raw: string): string {
  let v = raw.trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.replace(/^www\./, '');
  return v.replace(/\/+$/, '');
}

function titleCase(key: string): string {
  return key.charAt(0) + key.slice(1).toLowerCase();
}

/** Normalise a raw value for storage, per scope. Throws ValidationError when invalid. */
function normalizeValue(scope: BlocklistScope, raw: string): string {
  switch (scope) {
    case 'DOMAIN': {
      const v = normalizeDomain(raw);
      if (!v) throw new ValidationError('Domain value is empty after normalisation');
      return v;
    }
    case 'CATEGORY': {
      const v = raw.trim().toUpperCase();
      if (!ALL_CATEGORIES.includes(v)) {
        throw new ValidationError(`Unknown advertising category: "${raw}"`, {
          valid: [...ALL_CATEGORIES],
        });
      }
      return v;
    }
    case 'ADVERTISER':
    case 'CAMPAIGN': {
      const v = raw.trim().toLowerCase();
      if (!v) throw new ValidationError(`${scope} value is required`);
      return v;
    }
  }
}

/** List every blocklist entry for a channel, newest first. */
export async function listBlocklist(channelId: string): Promise<unknown> {
  return prisma.publisherBlocklist.findMany({
    where: { channelId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Add (or re-affirm) a blocklist entry. Ownership of the channel is
 * verified first; re-adding the same scope+value is a no-op upsert, not an
 * error.
 */
export async function addBlocklistEntry(
  ownerId: string,
  input: { channelId: string; scope: BlocklistScope; value: string; label?: string },
): Promise<unknown> {
  await assertChannelOwner(ownerId, input.channelId);

  const value = normalizeValue(input.scope, input.value);

  const entry = await prisma.publisherBlocklist.upsert({
    where: {
      channelId_scope_value: { channelId: input.channelId, scope: input.scope, value },
    },
    update: input.label !== undefined ? { label: input.label } : {},
    create: {
      channelId: input.channelId,
      scope: input.scope,
      value,
      label: input.label ?? null,
    },
  });

  await recordAudit({
    actorId: ownerId,
    actorType: 'USER',
    action: 'BLOCKLIST_ENTRY_ADDED',
    targetType: 'CHANNEL',
    targetId: input.channelId,
    newValue: { scope: input.scope, value },
  });

  return entry;
}

/** Remove a blocklist entry. 404 when the entry does not exist. */
export async function removeBlocklistEntry(ownerId: string, id: string): Promise<void> {
  const entry = await prisma.publisherBlocklist.findUnique({ where: { id } });
  if (!entry) throw new NotFoundError('Blocklist entry');

  await assertChannelOwner(ownerId, entry.channelId);

  await prisma.publisherBlocklist.delete({ where: { id } });

  await recordAudit({
    actorId: ownerId,
    actorType: 'USER',
    action: 'BLOCKLIST_ENTRY_REMOVED',
    targetType: 'CHANNEL',
    targetId: entry.channelId,
    oldValue: { scope: entry.scope, value: entry.value },
  });
}

/**
 * Check a concrete delivery context against one channel's blocklist.
 * Returns the first matching reason; reasons are written for the advertiser
 * to read (e.g. "This channel blocks your account").
 */
export async function isBlocked(input: {
  channelId: string;
  advertiserId?: string;
  campaignId?: string;
  category?: string | null;
  domain?: string | null;
}): Promise<{ blocked: boolean; reason?: string }> {
  const entries = await prisma.publisherBlocklist.findMany({
    where: { channelId: input.channelId },
  });

  const advertiserId = input.advertiserId?.trim().toLowerCase() ?? null;
  const campaignId = input.campaignId?.trim().toLowerCase() ?? null;
  const category = input.category?.trim().toUpperCase() ?? null;
  const domain = input.domain ? normalizeDomain(input.domain) : null;

  for (const entry of entries) {
    switch (entry.scope) {
      case 'ADVERTISER':
        if (advertiserId && entry.value === advertiserId) {
          return { blocked: true, reason: 'This channel blocks your account' };
        }
        break;
      case 'CAMPAIGN':
        if (campaignId && entry.value === campaignId) {
          return { blocked: true, reason: 'This channel blocks this campaign' };
        }
        break;
      case 'CATEGORY':
        if (category && entry.value === category) {
          return {
            blocked: true,
            reason: `This channel blocks ${titleCase(entry.value)} advertisements`,
          };
        }
        break;
      case 'DOMAIN':
        if (domain && entry.value === domain) {
          return { blocked: true, reason: 'This channel blocks this domain' };
        }
        break;
    }
  }

  return { blocked: false };
}

/**
 * Channel-level screening for campaign targeting: given a campaign's context,
 * return the de-duplicated ids of channels whose blocklist rejects it.
 */
export async function blockedChannelIdsForCampaign(input: {
  advertiserId: string;
  campaignId?: string;
  category?: string | null;
  domain?: string | null;
  channelIds?: string[];
}): Promise<string[]> {
  const or: Array<{ scope: BlocklistScope; value: string }> = [
    { scope: 'ADVERTISER', value: input.advertiserId.trim().toLowerCase() },
  ];

  if (input.campaignId) {
    or.push({ scope: 'CAMPAIGN', value: input.campaignId.trim().toLowerCase() });
  }
  if (input.category) {
    or.push({ scope: 'CATEGORY', value: input.category.trim().toUpperCase() });
  }
  if (input.domain) {
    const domain = normalizeDomain(input.domain);
    if (domain) or.push({ scope: 'DOMAIN', value: domain });
  }

  const rows = await prisma.publisherBlocklist.findMany({
    where: {
      OR: or,
      ...(input.channelIds && input.channelIds.length > 0
        ? { channelId: { in: input.channelIds } }
        : {}),
    },
    select: { channelId: true },
  });

  return [...new Set(rows.map((r) => r.channelId))];
}

/** Entry counts per scope for a channel (all four scopes always present). */
export async function blocklistSummary(channelId: string): Promise<Record<string, number>> {
  const rows = await prisma.publisherBlocklist.groupBy({
    by: ['scope'],
    where: { channelId },
    _count: { _all: true },
  });

  const summary: Record<string, number> = {};
  for (const scope of ALL_SCOPES) summary[scope] = 0;
  for (const row of rows) summary[row.scope] = row._count._all;
  return summary;
}

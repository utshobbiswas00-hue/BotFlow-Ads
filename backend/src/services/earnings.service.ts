import type { EarningStatus } from '@prisma/client';
import { prisma, transaction } from '../db/prisma';
import { releaseEarning } from './escrow.service';
import { businessRules } from './settings.service';
import { buildPaginated, type Pagination, type PaginatedResult } from '../utils/pagination';
import { logger } from '../config/logger';

/**
 * Publisher earnings.
 *
 * Earnings are created PENDING by `chargeDelivery` (escrow.service) and sit
 * in the wallet's `pending` bucket for the configured hold period. Once they
 * mature, `releaseMaturedEarnings` moves them to `available` — always
 * through `releaseEarning`, the only code path that may do so. This module
 * never writes to the wallets table directly.
 */

export interface EarningRow {
  id: string;
  channelTitle: string;
  campaignName: string;
  grossCents: number;
  netCents: number;
  status: EarningStatus;
  createdAt: Date;
  availableAt: Date | null;
}

export type EarningList = PaginatedResult<EarningRow>;

export async function listEarnings(userId: string, p: Pagination): Promise<EarningList> {
  const where = { publisherId: userId };

  const [total, rows] = await Promise.all([
    prisma.publisherEarning.count({ where }),
    prisma.publisherEarning.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        campaignId: true,
        grossCents: true,
        netCents: true,
        status: true,
        createdAt: true,
        availableAt: true,
        channel: { select: { title: true } },
      },
    }),
  ]);

  // PublisherEarning stores campaignId without a relation — resolve names
  // with one extra query for the page's worth of campaigns.
  //
  // campaignId is nullable: a HOUSE post earns the publisher without any campaign
  // existing, so those rows are excluded from the lookup and labelled below.
  const campaignIds = [
    ...new Set(rows.map((r) => r.campaignId).filter((id): id is string => Boolean(id))),
  ];
  const campaigns =
    campaignIds.length > 0
      ? await prisma.campaign.findMany({
          where: { id: { in: campaignIds } },
          select: { id: true, name: true },
        })
      : [];
  const campaignNameById = new Map(campaigns.map((c) => [c.id, c.name]));

  const items: EarningRow[] = rows.map((row) => ({
    id: row.id,
    channelTitle: row.channel.title,
    campaignName: row.campaignId
      ? (campaignNameById.get(row.campaignId) ?? '—')
      : 'BotFlow promotion',
    grossCents: row.grossCents,
    netCents: row.netCents,
    status: row.status,
    createdAt: row.createdAt,
    availableAt: row.availableAt,
  }));

  return buildPaginated(items, total, p);
}

/**
 * Release every PENDING earning that has passed the hold period.
 * Each earning is released inside its own transaction so one failure never
 * blocks the rest of the batch and the ledger stays consistent.
 *
 * @returns the number of earnings actually moved from pending to available.
 */
export async function releaseMaturedEarnings(limit = 200): Promise<number> {
  const holdHours = await businessRules.earningHoldHours();
  const cutoff = new Date(Date.now() - holdHours * 60 * 60 * 1000);

  const matured = await prisma.publisherEarning.findMany({
    where: { status: 'PENDING', createdAt: { lte: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: Math.max(1, Math.trunc(limit)),
    select: { id: true },
  });

  let released = 0;
  for (const earning of matured) {
    try {
      const result = await transaction((tx) => releaseEarning(tx, earning.id));
      if (result.released) released += 1;
    } catch (err) {
      logger.warn({ earningId: earning.id, err }, 'failed to release matured earning');
    }
  }

  if (released > 0) {
    logger.info({ released, candidates: matured.length, holdHours }, 'matured earnings released');
  }
  return released;
}

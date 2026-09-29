import type { DeliveryEventType, DeliveryErrorCode, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';

/**
 * DELIVERY AUDIT TRAIL
 *
 * Append-only history of what happened to a delivery and in what order, so
 * "why was this post never published?" can be answered by reading rows rather
 * than by guessing from the job's current state.
 *
 * Every writer is a no-op on failure by design: an audit write must never be the
 * reason a legitimate post does not go out. Failures are logged at error level so
 * a broken trail is still visible in the logs.
 */

export interface DeliveryEventInput {
  deliveryJobId: string;
  type: DeliveryEventType;
  actorType?: 'SYSTEM' | 'ADMIN' | 'PUBLISHER';
  actorId?: string | null;
  message?: string | null;
  errorCode?: DeliveryErrorCode | null;
  attempt?: number;
  metadata?: unknown;
}

/** Record one event. Pass a transaction client to keep it atomic with the change. */
export async function recordDeliveryEvent(
  tx: Prisma.TransactionClient | null,
  input: DeliveryEventInput,
): Promise<void> {
  const client = tx ?? prisma;

  try {
    await client.deliveryEvent.create({
      data: {
        deliveryJobId: input.deliveryJobId,
        type: input.type,
        actorType: input.actorType ?? 'SYSTEM',
        actorId: input.actorId ?? null,
        message: input.message ? input.message.slice(0, 1000) : null,
        errorCode: input.errorCode ?? null,
        attempt: input.attempt ?? 0,
        metadata: (input.metadata ?? null) as never,
      },
    });
  } catch (err) {
    logger.error(
      { err, deliveryJobId: input.deliveryJobId, type: input.type },
      'failed to write delivery event (continuing)',
    );
  }
}

/** Fire-and-forget variant for places where awaiting would slow a hot path. */
export function recordDeliveryEventAsync(input: DeliveryEventInput): void {
  void recordDeliveryEvent(null, input);
}

/** Full ordered history for one delivery, for the admin view. */
export async function getDeliveryTimeline(deliveryJobId: string) {
  return prisma.deliveryEvent.findMany({
    where: { deliveryJobId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      type: true,
      actorType: true,
      actorId: true,
      message: true,
      errorCode: true,
      attempt: true,
      metadata: true,
      createdAt: true,
    },
  });
}

/** Recent events across the platform, for the admin activity feed. */
export async function recentDeliveryEvents(limit = 50) {
  return prisma.deliveryEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      deliveryJobId: true,
      type: true,
      actorType: true,
      message: true,
      errorCode: true,
      createdAt: true,
      deliveryJob: {
        select: {
          id: true,
          channel: { select: { title: true } },
          campaign: { select: { name: true } },
        },
      },
    },
  });
}

/** Counts per event type, for the delivery health panel. */
export async function deliveryEventCounts(sinceHours = 24): Promise<Record<string, number>> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const grouped = await prisma.deliveryEvent.groupBy({
    by: ['type'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  return Object.fromEntries(grouped.map((g) => [g.type, g._count._all]));
}

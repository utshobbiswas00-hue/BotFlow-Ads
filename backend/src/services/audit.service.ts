import { prisma } from '../db/prisma';
import { logger } from '../config/logger';

/** Hard ceiling on one page of audit rows. */
const MAX_AUDIT_PAGE = 200;

export interface AuditInput {
  actorId?: string | null;
  actorType?: 'ADMIN' | 'USER' | 'SYSTEM';
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Append-only audit trail for admin actions.
 * Section 63 of the spec: who changed what, from which value to which value.
 * Never throws — an audit failure must not roll back the business action.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorType: input.actorType ?? 'ADMIN',
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        oldValue: (input.oldValue ?? null) as never,
        newValue: (input.newValue ?? null) as never,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
    logger.debug({ action: input.action, targetId: input.targetId }, 'audit recorded');
  } catch (err) {
    logger.error({ err, action: input.action }, 'failed to write audit log');
  }
}

export interface AuditListQuery {
  actorId?: string;
  action?: string;
  targetType?: string;
  from?: Date;
  to?: Date;
  skip?: number;
  take?: number;
}

export async function listAuditLogs(q: AuditListQuery) {
  const where = {
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.action ? { action: { contains: q.action, mode: 'insensitive' as const } } : {}),
    ...(q.targetType ? { targetType: q.targetType } : {}),
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from ? { gte: q.from } : {}),
            ...(q.to ? { lte: q.to } : {}),
          },
        }
      : {}),
  };

  // Bound both offsets regardless of what the caller passed: an unbounded
  // `take` on the (append-only, fast-growing) audit log is a trivial way to
  // exhaust memory from an admin screen.
  const take = Math.min(Math.max(Math.trunc(q.take ?? 20) || 20, 1), MAX_AUDIT_PAGE);
  const skip = Math.max(0, Math.trunc(q.skip ?? 0) || 0);

  const [total, items] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        actor: {
          select: { id: true, username: true, firstName: true, telegramId: true },
        },
      },
    }),
  ]);

  return { total, items };
}

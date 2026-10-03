import { Prisma, CampaignStatus } from '@prisma/client';
import { logger } from '../config/logger';
import { ConflictError, NotFoundError } from '../utils/errors';

/**
 * Campaign state machine.
 *
 * Single source of truth for every campaign status change. Any code path
 * (admin action, worker, scheduler) that mutates Campaign.status MUST go
 * through transitionCampaign, which enforces:
 *   1. the transition table (assertTransition)
 *   2. a concurrency guard (re-read + status compare inside the caller's tx)
 *   3. an append-only audit row written in the same transaction
 *
 * ALLOWED_TRANSITIONS is typed Record<CampaignStatus, CampaignStatus[]>, so
 * adding an enum member to schema.prisma without a row here is a COMPILE
 * error, not a silent hole in the state machine.
 */

/** Allowed outgoing transitions per state. Terminal states map to []. */
export const ALLOWED_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  DRAFT: ['PENDING_REVIEW', 'CANCELLED'],
  PENDING_REVIEW: ['APPROVED', 'REJECTED', 'CANCELLED'],
  // APPROVED → EXPIRED: an approved campaign whose window closed before it ever
  // started. The expiry sweep selects APPROVED campaigns too, so without this edge a
  // campaign that was approved and then simply ran out of time could not be moved out
  // of APPROVED at all — `assertTransition` would refuse and the sweep would log a
  // failure on every pass.
  APPROVED: ['SCHEDULED', 'RUNNING', 'PAUSED', 'CANCELLED', 'SUSPENDED', 'EXPIRED'],
  SCHEDULED: ['RUNNING', 'PAUSED', 'CANCELLED', 'EXPIRED', 'SUSPENDED'],
  RUNNING: ['PAUSED', 'COMPLETED', 'CANCELLED', 'SUSPENDED', 'EXPIRED'],
  PAUSED: ['RUNNING', 'SCHEDULED', 'CANCELLED', 'EXPIRED', 'SUSPENDED'],
  SUSPENDED: ['RUNNING', 'PAUSED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
};

/** States that have no outgoing transitions. */
export const TERMINAL_STATES: CampaignStatus[] = ['COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED'];

/** Defensive copy of the states reachable from `from`. */
export function allowedNextStates(from: CampaignStatus): CampaignStatus[] {
  return [...ALLOWED_TRANSITIONS[from]];
}

/** Whether the from→to edge exists in the table. Self-transitions are NOT in the table. */
export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Throws ConflictError unless from→to is an allowed edge. */
export function assertTransition(from: CampaignStatus, to: CampaignStatus): void {
  if (canTransition(from, to)) return;
  const allowed = allowedNextStates(from);
  const allowedText = allowed.length > 0 ? allowed.join(', ') : 'none';
  throw new ConflictError(
    `Cannot move a campaign from ${from} to ${to}. Allowed from ${from}: ${allowedText}.`,
    { from, to, allowed },
  );
}

/**
 * Which timestamp column a transition should stamp, if any.
 * APPROVED and REJECTED both represent a review decision → reviewedAt.
 */
export function transitionTimestampField(to: CampaignStatus): string | null {
  if (to === 'APPROVED' || to === 'REJECTED') return 'reviewedAt';
  return null;
}

export interface TransitionCampaignInput {
  campaignId: string;
  from: CampaignStatus;
  to: CampaignStatus;
  actorType: 'ADMIN' | 'USER' | 'SYSTEM';
  actorId?: string | null;
  reason?: string;
  extraData?: Record<string, unknown>;
}

/**
 * Atomically move a campaign from `from` to `to` inside the caller's
 * transaction, then append the audit row in the SAME transaction.
 *
 * The caller is responsible for committing/rolling back `tx`.
 */
export async function transitionCampaign(
  tx: Prisma.TransactionClient,
  input: TransitionCampaignInput,
): Promise<void> {
  const { campaignId, from, to, actorType, actorId, reason, extraData } = input;

  // 1. Idempotent no-op: same-state "transitions" write nothing.
  if (from === to) return;

  // 2. Enforce the transition table.
  assertTransition(from, to);

  // 3. Concurrency guard: re-read the row inside this transaction and
  //    verify it is still in the state the caller assumed. If a rival
  //    actor (e.g. a second admin) committed a status change first, the
  //    read returns their status, this throws 409 and the transaction
  //    aborts — both cannot win.
  const current = await tx.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true },
  });
  if (!current) throw new NotFoundError('Campaign');
  if (current.status !== from) {
    throw new ConflictError(
      `Campaign status changed concurrently: expected ${from}, found ${current.status}`,
      { campaignId, expected: from, actual: current.status },
    );
  }

  // 4. Apply the transition (review stamp + caller-supplied extras).
  const stamp = transitionTimestampField(to);
  const data: Prisma.CampaignUpdateInput = {
    status: to,
    ...(stamp === 'reviewedAt' ? { reviewedAt: new Date() } : {}),
  };
  if (extraData) Object.assign(data, extraData);
  await tx.campaign.update({ where: { id: campaignId }, data });

  // 5. Audit row in the SAME transaction — NOT recordAudit(), which would
  //    open its own connection and could commit out-of-band. A broken audit
  //    write must never roll back a legitimate status change: log & swallow.
  try {
    await tx.auditLog.create({
      data: {
        actorId: actorId ?? null,
        actorType,
        action: 'CAMPAIGN_STATUS_CHANGED',
        targetType: 'CAMPAIGN',
        targetId: campaignId,
        oldValue: { status: from },
        newValue: { status: to, actorType, actorId: actorId ?? null, reason: reason ?? null },
      },
    });
  } catch (err) {
    logger.warn(
      { err, campaignId, from, to, actorType },
      'failed to write CAMPAIGN_STATUS_CHANGED audit row',
    );
  }

  // 6. Info log.
  logger.info({ campaignId, from, to, actorType, actorId, reason }, 'campaign status transitioned');
}

export interface CreateCampaignAuditInput {
  campaignId: string;
  actorType: 'ADMIN' | 'USER' | 'SYSTEM';
  actorId?: string | null;
  note?: string;
}

/**
 * Append a CAMPAIGN_CREATED audit row inside the caller's transaction.
 * Same rule as transitionCampaign: a failed audit write is logged, never
 * rethrown, so it cannot roll back the campaign insert.
 */
export async function createCampaignAudit(
  tx: Prisma.TransactionClient,
  input: CreateCampaignAuditInput,
): Promise<void> {
  const { campaignId, actorType, actorId, note } = input;
  try {
    await tx.auditLog.create({
      data: {
        actorId: actorId ?? null,
        actorType,
        action: 'CAMPAIGN_CREATED',
        targetType: 'CAMPAIGN',
        targetId: campaignId,
        newValue: { note: note ?? null },
      },
    });
  } catch (err) {
    logger.warn({ err, campaignId, actorType }, 'failed to write CAMPAIGN_CREATED audit row');
  }
}

import type { AdminRole, UserStatus } from '@prisma/client';
import { prisma } from '../db/prisma';
import { recordAudit } from './audit.service';
import { ForbiddenError, NotFoundError } from '../utils/errors';

/**
 * User moderation — suspend / unsuspend / ban / unban.
 *
 * Until now an admin could search, inspect and adjust a user's balance but had
 * no way to actually stop one: the `UserStatus` enum (ACTIVE / SUSPENDED /
 * BANNED) and the `User.suspendedReason` column already existed and were simply
 * never written. These four helpers are the only write path for them.
 *
 * ENFORCEMENT IS AUTOMATIC — no other route needs to change. Every
 * authenticated API request already runs through `middleware/telegramAuth.ts`,
 * whose `requireActive` option rejects a BANNED or SUSPENDED user with 403 for
 * the WHOLE API. Flipping `User.status` here is therefore enough to lock the
 * account out everywhere at once.
 *
 * THIS TOUCHES NO MONEY. Reserved escrow, open campaigns and wallet balances of
 * a suspended/banned user are deliberately left exactly as they are — moderation
 * is not a settlement event. If funds ever need to move, that is a separate,
 * audited financial action (see the finance/escrow services), not a side effect
 * of a status change.
 */

/** Extra request context a route can pass through to the audit trail. */
export interface ModerationContext {
  /** The acting admin's role — the route reads it from `req.admin.role`. */
  actorRole?: AdminRole;
  /** Request IP, recorded on the audit row. */
  ip?: string | null;
  /** Request user agent, recorded on the audit row. */
  userAgent?: string | null;
}

/** The exact shape returned by every helper below. */
export interface ModeratedUser {
  id: string;
  status: UserStatus;
  suspendedReason: string | null;
}

const USER_SELECT = {
  id: true,
  status: true,
  suspendedReason: true,
} as const;

/**
 * Refuse any moderation aimed at the actor's own account.
 *
 * `actorId` is the acting admin's USER id (the row `AuditLog.actor` references),
 * so a plain identity comparison is enough — without this check an admin who is
 * also a SUPER_ADMIN could ban themselves and lock the panel out of the very
 * account that would have to undo it.
 */
function assertNotSelf(actorId: string, userId: string): void {
  if (actorId === userId) {
    throw new ForbiddenError('You cannot suspend or ban your own account.');
  }
}

/** Load the target user or 404. */
async function loadUser(userId: string): Promise<ModeratedUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: USER_SELECT,
  });
  if (!user) throw new NotFoundError('User');
  return user;
}

/**
 * A user who still holds an ACTIVE `AdminUser` row is protected: only a
 * SUPER_ADMIN may suspend or ban them, so a moderator cannot quietly lock out
 * the staff who would have to undo it. A deactivated admin row does not protect
 * its user — deactivation is the explicit way to remove that shield.
 */
async function assertAdminNotProtected(userId: string, actorRole: AdminRole | undefined): Promise<void> {
  const admin = await prisma.adminUser.findUnique({
    where: { userId },
    select: { isActive: true },
  });
  if (admin?.isActive && actorRole !== 'SUPER_ADMIN') {
    throw new ForbiddenError(
      'This user is an active admin. Only a SUPER_ADMIN can suspend or ban an admin.',
    );
  }
}

/**
 * Apply one status change, guarded and audited.
 *
 * IDEMPOTENT: if the user is already in the requested status the call is a
 * no-op that returns the current row (HTTP 200, no error). No audit row is
 * written in that case — an audit entry records a transition, and nothing
 * transitioned.
 */
async function changeUserStatus(
  actorId: string,
  userId: string,
  action: string,
  next: { status: UserStatus; suspendedReason: string | null },
  ctx: ModerationContext,
  protectActiveAdmin: boolean,
): Promise<ModeratedUser> {
  assertNotSelf(actorId, userId);

  const before = await loadUser(userId);

  // Guard runs BEFORE the idempotency short-circuit: re-suspending an (already
  // suspended) active admin must still be refused to a non-SUPER_ADMIN.
  if (protectActiveAdmin) await assertAdminNotProtected(userId, ctx.actorRole);

  // Already in the target state? For SUSPENDED/BANNED any repeated call is a
  // no-op; for the ACTIVE clears we additionally require the reason to already
  // be null so a stray reason cannot be left behind.
  const alreadyThere =
    before.status === next.status && (next.status !== 'ACTIVE' || before.suspendedReason === null);
  if (alreadyThere) return before;

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { status: next.status, suspendedReason: next.suspendedReason },
    select: USER_SELECT,
  });

  await recordAudit({
    actorId,
    actorType: 'ADMIN',
    action,
    targetType: 'USER',
    targetId: userId,
    oldValue: { status: before.status, suspendedReason: before.suspendedReason },
    newValue: { status: updated.status, suspendedReason: updated.suspendedReason },
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  return updated;
}

/** Set the user SUSPENDED and record why. */
export function setUserSuspension(
  actorId: string,
  userId: string,
  reason: string,
  ctx: ModerationContext = {},
): Promise<ModeratedUser> {
  return changeUserStatus(
    actorId,
    userId,
    'USER_SUSPENDED',
    { status: 'SUSPENDED', suspendedReason: reason },
    ctx,
    true,
  );
}

/** Lift a suspension: back to ACTIVE and clear the recorded reason. */
export function clearUserSuspension(
  actorId: string,
  userId: string,
  ctx: ModerationContext = {},
): Promise<ModeratedUser> {
  return changeUserStatus(
    actorId,
    userId,
    'USER_UNSUSPENDED',
    { status: 'ACTIVE', suspendedReason: null },
    ctx,
    false,
  );
}

/** Set the user BANNED and record why. */
export function banUser(
  actorId: string,
  userId: string,
  reason: string,
  ctx: ModerationContext = {},
): Promise<ModeratedUser> {
  return changeUserStatus(
    actorId,
    userId,
    'USER_BANNED',
    { status: 'BANNED', suspendedReason: reason },
    ctx,
    true,
  );
}

/** Lift a ban: back to ACTIVE and clear the recorded reason. */
export function unbanUser(
  actorId: string,
  userId: string,
  ctx: ModerationContext = {},
): Promise<ModeratedUser> {
  return changeUserStatus(
    actorId,
    userId,
    'USER_UNBANNED',
    { status: 'ACTIVE', suspendedReason: null },
    ctx,
    false,
  );
}

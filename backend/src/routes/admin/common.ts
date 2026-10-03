import type { Request, Response } from 'express';
import { z } from 'zod';
import { ForbiddenError } from '../../utils/errors';

/**
 * Internal helpers for the admin router.
 *
 * The router's public export is `adminRouter` (see index.ts); everything in
 * this file is implementation detail shared by the sub-routers.
 */

/** Shared `:id` param schema for admin routes with a path parameter. */
export const idParams = z.object({ id: z.string().min(1) });

/**
 * The acting admin's **User** id.
 *
 * Every audit field needs THIS id and not the `AdminUser.id`: `AuditLog.actorId`
 * and `TicketMessage.senderId` both reference `User`, so an `AdminUser.id` written
 * into them raises a foreign-key violation. `recordAudit` swallows that error on
 * purpose — an audit write must never fail the action it describes — which is what
 * turned the mistake into a silent one: the action succeeded and its audit row
 * simply never appeared.
 *
 * `AdminUser.userId` is unique, so the acting admin stays unambiguous. Reach for
 * `adminRecordId` only where a genuinely AdminUser-scoped id is required (scoping
 * an AdminNotification to its owner, the self-deactivation guard).
 *
 * `requireAdmin` is applied at the router level in index.ts, so `req.user` is
 * always present here — the guard exists for type-level safety.
 */
export function adminUserId(req: Request): string {
  const user = req.user;
  if (!user) throw new ForbiddenError('Admin access required');
  return user.id;
}

/**
 * The acting admin's `AdminUser` row id.
 *
 * Deliberately separate from `adminUserId`: the two ids differ, and a field that
 * references `User` must never receive this one.
 */
export function adminRecordId(req: Request): string {
  const admin = req.admin;
  if (!admin) throw new ForbiddenError('Admin access required');
  return admin.id;
}

function convertValue(value: unknown): unknown {
  // Prisma BigInt columns (telegramId, telegramChannelId, ...) cannot be
  // serialised by JSON.stringify — Express would crash with 500.
  if (typeof value === 'bigint') return value.toString();
  // Dates serialise to ISO strings on their own; keep them as-is.
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(convertValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = convertValue(nested);
    return out;
  }
  return value;
}

/**
 * Make a service result JSON-safe by converting every embedded bigint to its
 * decimal string. Numbers, strings, booleans, null, Dates and plain JSON
 * values pass through untouched.
 */
export function jsonSafe<T>(value: T): T {
  return convertValue(value) as T;
}

/** Standard success envelope: `{ ok: true, data }`, always JSON-safe. */
export function respondOk(res: Response, data: unknown): void {
  res.json({ ok: true, data: jsonSafe(data) });
}

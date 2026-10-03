import { Router } from 'express';
import { AdminRole } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { ADMIN_PERMISSIONS, requireRole } from '../../middleware/adminAuth';
import { prisma } from '../../db/prisma';
import { recordAudit } from '../../services/audit.service';
import { AppError, NotFoundError } from '../../utils/errors';
import { displayName } from '../../utils/format';
import { buildPaginated, getPagination } from '../../utils/pagination';
import { adminRecordId, adminUserId, idParams, respondOk } from './common';

/**
 * Admin management — SUPER_ADMIN only.
 *
 * Deactivation (never hard-delete) keeps audit references resolvable.
 */
export const adminUsersRouter = Router();

adminUsersRouter.use(requireRole('SUPER_ADMIN'));

const USER_SELECT = {
  id: true,
  telegramId: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

const ADMIN_SELECT = {
  id: true,
  role: true,
  permissions: true,
  isActive: true,
  createdById: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: USER_SELECT },
} satisfies Prisma.AdminUserSelect;

type AdminUserRow = Prisma.AdminUserGetPayload<{ select: typeof ADMIN_SELECT }>;

function toAdminUserItem(row: AdminUserRow) {
  return {
    id: row.id,
    role: row.role,
    permissions: row.permissions,
    isActive: row.isActive,
    createdById: row.createdById,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    userId: row.user.id,
    userName: displayName(row.user),
    username: row.user.username,
    // BigInt column — always serialise as a decimal string.
    telegramId: row.user.telegramId.toString(),
  };
}

const createAdminUserSchema = z.object({
  telegramId: z
    .string()
    .regex(/^\d{1,19}$/, 'telegramId must be a numeric Telegram user id')
    .transform((v) => v.replace(/^0+(?=\d)/, '')),
  role: z.nativeEnum(AdminRole),
});

/**
 * The permission keys in `permissions` that are NOT in the `ADMIN_PERMISSIONS`
 * catalogue. Returns `[]` when every key is known.
 *
 * Exported (and kept pure) so it can be unit-tested without a database.
 */
export function findUnknownPermissions(permissions: readonly string[]): string[] {
  const allowed = new Set<string>(ADMIN_PERMISSIONS);
  return permissions.filter((key) => !allowed.has(key));
}

export const updateAdminUserSchema = z
  .object({
    role: z.nativeEnum(AdminRole).optional(),
    isActive: z.boolean().optional(),
    /**
     * Replaces the whole permission array. Keys are checked against
     * ADMIN_PERMISSIONS in the handler rather than here: an unknown key must be
     * a 400 that NAMES it, and a silent zod strip would be exactly the failure
     * mode this field exists to fix.
     */
    permissions: z.array(z.string()).max(64).optional(),
  })
  .refine((d) => d.role !== undefined || d.isActive !== undefined || d.permissions !== undefined, {
    message: 'Provide at least one of: role, isActive, permissions',
  });

/** All admin accounts, joined with the underlying user's profile. */
adminUsersRouter.get('/', validate({ query: paginationSchema }), async (req, res, next) => {
  try {
    const p = getPagination(req.query);
    const [total, rows] = await Promise.all([
      prisma.adminUser.count(),
      prisma.adminUser.findMany({
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
        select: ADMIN_SELECT,
      }),
    ]);
    respondOk(res, buildPaginated(rows.map(toAdminUserItem), total, p));
  } catch (err) {
    next(err);
  }
});

/** Grant (or re-grant) admin access to a registered user, by telegramId. */
adminUsersRouter.post('/', validate({ body: createAdminUserSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createAdminUserSchema>;
    const actor = adminUserId(req);

    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(body.telegramId) },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundError('User', { hint: `No registered user with telegram id ${body.telegramId}` });
    }

    const admin = await prisma.adminUser.upsert({
      where: { userId: user.id },
      create: { userId: user.id, role: body.role, createdById: req.user?.id ?? null },
      update: { role: body.role, isActive: true },
      select: ADMIN_SELECT,
    });

    await recordAudit({
      actorId: actor,
      actorType: 'ADMIN',
      action: 'ADMIN_USER_CREATED',
      targetType: 'ADMIN_USER',
      targetId: admin.id,
      oldValue: null,
      newValue: { userId: admin.user.id, role: admin.role, isActive: admin.isActive },
    });

    respondOk(res, toAdminUserItem(admin));
  } catch (err) {
    next(err);
  }
});

/** Change an admin's role, active flag and/or permission keys. */
/**
 * Refuse a change that would leave the panel with nobody able to administer it.
 *
 * There was no guard here at all, and this failure is total rather than partial: the
 * last active SUPER_ADMIN could deactivate — or demote — their own account, and the
 * panel would lock out everybody including the person who did it. The only way back
 * is a manual database write.
 *
 * Two rules, both judged on the RESULTING state rather than on what was asked for:
 *
 *   1. an admin may not remove their own access, and
 *   2. the last active SUPER_ADMIN may not be deactivated or demoted, so the panel
 *      always keeps one account that can manage admins.
 *
 * A change that leaves a SUPER_ADMIN a SUPER_ADMIN is always allowed, and editing
 * your own permission list is untouched — this is about losing access, not about
 * editing.
 */
export async function assertAdminAccessSurvives(input: {
  target: { id: string; role: AdminRole; isActive: boolean };
  actorAdminId: string;
  resultingRole?: AdminRole;
  resultingIsActive?: boolean;
}): Promise<void> {
  const resultingRole = input.resultingRole ?? input.target.role;
  const resultingIsActive = input.resultingIsActive ?? input.target.isActive;

  const deactivates = input.target.isActive && !resultingIsActive;
  const losesSuperAdmin = input.target.role === AdminRole.SUPER_ADMIN && resultingRole !== AdminRole.SUPER_ADMIN;
  if (!deactivates && !losesSuperAdmin) return;

  if (input.target.id === input.actorAdminId) {
    throw new AppError(
      'You cannot remove your own admin access. Ask another SUPER_ADMIN to change or deactivate your account.',
      400,
    );
  }

  // Only an account that currently props the panel up can take the last one away.
  if (input.target.isActive && input.target.role === AdminRole.SUPER_ADMIN) {
    const remaining = await prisma.adminUser.count({
      where: { role: AdminRole.SUPER_ADMIN, isActive: true, id: { not: input.target.id } },
    });
    if (remaining === 0) {
      throw new AppError(
        'This is the only active SUPER_ADMIN. Deactivating or demoting it would lock everyone out of the admin panel, so the change is refused.',
        400,
      );
    }
  }
}

adminUsersRouter.patch('/:id', validate({ params: idParams, body: updateAdminUserSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof updateAdminUserSchema>;
    const actor = adminUserId(req);

    const existing = await prisma.adminUser.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError('Admin');

    // The role that will be in force AFTER this update — a permission list has
    // to be judged against the resulting role, not only the stored one (a single
    // request may promote to SUPER_ADMIN and set permissions at the same time).
    const effectiveRole = body.role ?? existing.role;

    if (body.permissions !== undefined) {
      // Reject unknown keys instead of dropping them: a dropped key either
      // grants access nobody intended (the array is still written) or leaves an
      // account unable to open the screen the caller thought they allowed.
      const unknown = findUnknownPermissions(body.permissions);
      if (unknown.length > 0) {
        throw new AppError(
          `Unknown permission key(s): ${unknown.join(', ')}`,
          400,
          undefined,
          { unknownPermissions: unknown, allowed: ADMIN_PERMISSIONS },
        );
      }

      // SUPER_ADMIN bypasses `requirePermission` entirely, so a stored list
      // would only look like a restriction that is never actually applied.
      if (effectiveRole === AdminRole.SUPER_ADMIN) {
        throw new AppError(
          'permissions cannot be set on a SUPER_ADMIN account: SUPER_ADMIN bypasses every permission check, so a stored list would not be enforced',
          400,
          undefined,
        );
      }
    }

    await assertAdminAccessSurvives({
      target: existing,
      actorAdminId: adminRecordId(req),
      resultingRole: body.role,
      resultingIsActive: body.isActive,
    });

    const updated = await prisma.adminUser.update({
      where: { id: req.params.id },
      data: {
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
      },
      select: ADMIN_SELECT,
    });

    await recordAudit({
      actorId: actor,
      actorType: 'ADMIN',
      action: 'ADMIN_USER_UPDATED',
      targetType: 'ADMIN_USER',
      targetId: updated.id,
      oldValue: { role: existing.role, isActive: existing.isActive, permissions: existing.permissions },
      newValue: { role: updated.role, isActive: updated.isActive, permissions: updated.permissions },
    });

    respondOk(res, toAdminUserItem(updated));
  } catch (err) {
    next(err);
  }
});

/** Deactivate an admin account — never hard-deleted (audit trail integrity). */
adminUsersRouter.delete('/:id', validate({ params: idParams }), async (req, res, next) => {
  try {
    const actor = adminUserId(req);

    const existing = await prisma.adminUser.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new NotFoundError('Admin');

    await assertAdminAccessSurvives({
      target: existing,
      actorAdminId: adminRecordId(req),
      resultingIsActive: false,
    });

    const updated = await prisma.adminUser.update({
      where: { id: req.params.id },
      data: { isActive: false },
      select: ADMIN_SELECT,
    });

    await recordAudit({
      actorId: actor,
      actorType: 'ADMIN',
      action: 'ADMIN_USER_DEACTIVATED',
      targetType: 'ADMIN_USER',
      targetId: updated.id,
      oldValue: { role: existing.role, isActive: existing.isActive },
      newValue: { role: updated.role, isActive: false },
    });

    respondOk(res, toAdminUserItem(updated));
  } catch (err) {
    next(err);
  }
});

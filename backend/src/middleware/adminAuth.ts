import type { AdminRole } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db/prisma';
import type { AuthAdmin, AuthUser } from '../types/auth';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';

/**
 * Admin authorization, layered on top of `telegramAuth` (which populates
 * `req.user`). Routes are wired as:
 *
 *   router.use(telegramAuth(), requireAdmin(), requirePermission('users.view'))
 *
 * SUPER_ADMIN passes every role and permission check automatically; all
 * other roles need a matching `requireRole(...)` entry or an explicit key
 * in their AdminUser.permissions JSON array.
 */

/** Permission keys used across the admin panel. */
export const ADMIN_PERMISSIONS = [
  'dashboard.view',
  'users.view',
  'users.manage',
  'users.balance.adjust',
  'campaigns.view',
  'campaigns.manage',
  'channels.view',
  'channels.manage',
  'deposits.view',
  'deposits.manage',
  'withdrawals.view',
  'withdrawals.manage',
  'delivery.view',
  'delivery.manage',
  'fraud.view',
  'fraud.manage',
  'tickets.view',
  'tickets.manage',
  'settings.manage',
  'admins.manage',
  'audit.view',
  'broadcast.send',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/**
 * Require an authenticated user with an ACTIVE AdminUser row.
 * Throws 401 when `req.user` is missing and 403 when the user has no
 * active admin record. On success sets `req.admin` for the middlewares
 * that follow.
 */
export function requireAdmin() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const user: AuthUser | undefined = req.user;
      if (!user) throw new UnauthorizedError('Authentication required');

      const admin = await prisma.adminUser.findUnique({ where: { userId: user.id } });
      if (!admin || !admin.isActive) {
        throw new ForbiddenError('This account does not have admin access');
      }

      const permissions = Array.isArray(admin.permissions)
        ? (admin.permissions as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];

      req.admin = {
        id: admin.id,
        role: admin.role,
        permissions,
      } satisfies AuthAdmin;

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Require one of the given roles. Must run after `requireAdmin`.
 * SUPER_ADMIN always passes.
 */
export function requireRole(...roles: AdminRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const admin: AuthAdmin | undefined = req.admin;
      if (!admin) throw new ForbiddenError('Admin access required');
      if (admin.role === 'SUPER_ADMIN') return next();
      if (roles.includes(admin.role)) return next();
      throw new ForbiddenError(`This action requires role: ${roles.join(', ')}`);
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Require a specific permission key on the admin record. Must run after
 * `requireAdmin`. SUPER_ADMIN always passes.
 */
export function requirePermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const admin: AuthAdmin | undefined = req.admin;
      if (!admin) throw new ForbiddenError('Admin access required');
      if (admin.role === 'SUPER_ADMIN') return next();
      if (admin.permissions.includes(permission)) return next();
      throw new ForbiddenError(`Missing required permission: ${permission}`);
    } catch (err) {
      next(err);
    }
  };
}

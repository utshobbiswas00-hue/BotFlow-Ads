import { describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS } from '../../../middleware/adminAuth';
import { findUnknownPermissions, updateAdminUserSchema } from '../adminUsers.routes';

/**
 * DB-FREE unit tests for the permission-validation half of the admin-users
 * update route.
 *
 * `adminUsers.routes.ts` pulls in Prisma and the audit service at import time,
 * so both are mocked here — no PostgreSQL is touched. The handler's HTTP-400
 * behaviour (unknown key / SUPER_ADMIN) is driven by the SAME pure function and
 * catalogue exercised below; the schema is asserted to NOT strip unknown keys,
 * which is what makes the handler's naming 400 reachable.
 */
vi.mock('../../../db/prisma', () => ({
  prisma: {
    adminUser: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), upsert: vi.fn(), count: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
  transaction: vi.fn(),
}));

vi.mock('../../../services/audit.service', () => ({
  recordAudit: vi.fn(async () => undefined),
}));

describe('ADMIN_PERMISSIONS catalogue', () => {
  it('is exactly the existing 22 keys, with no duplicates', () => {
    expect(ADMIN_PERMISSIONS).toHaveLength(22);
    expect(new Set(ADMIN_PERMISSIONS).size).toBe(22);
  });
});

describe('findUnknownPermissions', () => {
  it('accepts the whole catalogue', () => {
    expect(findUnknownPermissions(ADMIN_PERMISSIONS)).toEqual([]);
  });

  it('accepts an empty list and a single known key', () => {
    expect(findUnknownPermissions([])).toEqual([]);
    expect(findUnknownPermissions(['dashboard.view'])).toEqual([]);
  });

  it('returns ONLY the offending keys, preserving input order', () => {
    expect(findUnknownPermissions(['users.del', 'dashboard.view', 'nope'])).toEqual(['users.del', 'nope']);
  });

  it('is exact-match: casing, whitespace and typos are all unknown', () => {
    expect(findUnknownPermissions(['DASHBOARD.VIEW'])).toEqual(['DASHBOARD.VIEW']);
    expect(findUnknownPermissions([' dashboard.view'])).toEqual([' dashboard.view']);
    expect(findUnknownPermissions(['dashboard.vieww'])).toEqual(['dashboard.vieww']);
  });
});

describe('updateAdminUserSchema', () => {
  it('accepts a permissions-only update', () => {
    const parsed = updateAdminUserSchema.parse({ permissions: ['dashboard.view', 'users.view'] });
    expect(parsed.permissions).toEqual(['dashboard.view', 'users.view']);
  });

  it('accepts an empty permissions array (clears every key)', () => {
    expect(updateAdminUserSchema.safeParse({ permissions: [] }).success).toBe(true);
  });

  it('still accepts the pre-existing role / isActive fields', () => {
    expect(updateAdminUserSchema.safeParse({ role: 'MODERATOR' }).success).toBe(true);
    expect(updateAdminUserSchema.safeParse({ isActive: false }).success).toBe(true);
  });

  it('rejects an update that carries none of role / isActive / permissions', () => {
    expect(updateAdminUserSchema.safeParse({}).success).toBe(false);
  });

  it('rejects more than 64 permission keys', () => {
    const tooMany = Array.from({ length: 65 }, () => 'dashboard.view');
    expect(updateAdminUserSchema.safeParse({ permissions: tooMany }).success).toBe(false);
  });

  it('rejects non-string permission keys', () => {
    expect(updateAdminUserSchema.safeParse({ permissions: [1, 2] }).success).toBe(false);
  });

  it('does NOT silently strip unknown keys — the handler must be able to name them', () => {
    const parsed = updateAdminUserSchema.parse({ permissions: ['totally.unknown'] });
    expect(parsed.permissions).toEqual(['totally.unknown']);
    expect(findUnknownPermissions(parsed.permissions ?? [])).toEqual(['totally.unknown']);
  });
});

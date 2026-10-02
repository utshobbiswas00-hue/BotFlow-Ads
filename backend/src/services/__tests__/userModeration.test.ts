import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../db/prisma';
import { recordAudit } from '../audit.service';
import { banUser, clearUserSuspension, setUserSuspension, unbanUser } from '../userModeration.service';
import { ForbiddenError, NotFoundError } from '../../utils/errors';

/**
 * DB-FREE unit tests for user moderation.
 *
 * userModeration.service talks to Prisma and to the audit service, so both are
 * mocked here — no PostgreSQL is touched. The point of these tests is the
 * GUARDS: refusing to act on your own account, refusing to touch an active
 * admin unless you are a SUPER_ADMIN, idempotency, the 404, and the exact
 * shape of the audit row.
 */
vi.mock('../../db/prisma', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    adminUser: { findUnique: vi.fn() },
  },
  transaction: vi.fn(),
}));

vi.mock('../audit.service', () => ({
  recordAudit: vi.fn(async () => undefined),
}));

const userFindUnique = vi.mocked(prisma.user.findUnique);
const userUpdate = vi.mocked(prisma.user.update);
const adminFindUnique = vi.mocked(prisma.adminUser.findUnique);
const audit = vi.mocked(recordAudit);

const SELECT = { id: true, status: true, suspendedReason: true };

function target(status: string, suspendedReason: string | null) {
  return { id: 'target', status, suspendedReason } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  adminFindUnique.mockResolvedValue(null as never);
});

describe('setUserSuspension', () => {
  it('suspends an active user, records the reason, and audits the transition', async () => {
    userFindUnique.mockResolvedValue(target('ACTIVE', null));
    userUpdate.mockResolvedValue({ id: 'target', status: 'SUSPENDED', suspendedReason: 'spam' } as never);

    const result = await setUserSuspension('actor', 'target', 'spam', {
      actorRole: 'MODERATOR',
      ip: '1.2.3.4',
      userAgent: 'vitest',
    });

    expect(result).toEqual({ id: 'target', status: 'SUSPENDED', suspendedReason: 'spam' });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'target' },
      data: { status: 'SUSPENDED', suspendedReason: 'spam' },
      select: SELECT,
    });
    expect(audit).toHaveBeenCalledWith({
      actorId: 'actor',
      actorType: 'ADMIN',
      action: 'USER_SUSPENDED',
      targetType: 'USER',
      targetId: 'target',
      oldValue: { status: 'ACTIVE', suspendedReason: null },
      newValue: { status: 'SUSPENDED', suspendedReason: 'spam' },
      ip: '1.2.3.4',
      userAgent: 'vitest',
    });
  });

  it('refuses to suspend the actor own account', async () => {
    await expect(setUserSuspension('self', 'self', 'because')).rejects.toBeInstanceOf(ForbiddenError);
    expect(userFindUnique).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('is idempotent: suspending an already-suspended user is a no-op that returns the row', async () => {
    userFindUnique.mockResolvedValue(target('SUSPENDED', 'old reason'));

    const result = await setUserSuspension('actor', 'target', 'a different reason');

    expect(result).toEqual({ id: 'target', status: 'SUSPENDED', suspendedReason: 'old reason' });
    expect(userUpdate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('404s for a user row that does not exist', async () => {
    userFindUnique.mockResolvedValue(null as never);
    await expect(setUserSuspension('actor', 'ghost', 'spam')).rejects.toBeInstanceOf(NotFoundError);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe('banUser — active-admin protection', () => {
  it('refuses to ban an active admin unless the actor is a SUPER_ADMIN', async () => {
    userFindUnique.mockResolvedValue(target('ACTIVE', null));
    adminFindUnique.mockResolvedValue({ isActive: true } as never);

    await expect(banUser('actor', 'target', 'fraud', { actorRole: 'MODERATOR' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(userUpdate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('allows a SUPER_ADMIN to ban an active admin', async () => {
    userFindUnique.mockResolvedValue(target('ACTIVE', null));
    adminFindUnique.mockResolvedValue({ isActive: true } as never);
    userUpdate.mockResolvedValue({ id: 'target', status: 'BANNED', suspendedReason: 'fraud' } as never);

    const result = await banUser('actor', 'target', 'fraud', { actorRole: 'SUPER_ADMIN' });

    expect(result.status).toBe('BANNED');
    expect(userUpdate).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'USER_BANNED', targetType: 'USER', targetId: 'target' }),
    );
  });

  it('does not protect a user whose admin row is deactivated', async () => {
    userFindUnique.mockResolvedValue(target('ACTIVE', null));
    adminFindUnique.mockResolvedValue({ isActive: false } as never);
    userUpdate.mockResolvedValue({ id: 'target', status: 'BANNED', suspendedReason: 'fraud' } as never);

    await banUser('actor', 'target', 'fraud', { actorRole: 'MODERATOR' });

    expect(userUpdate).toHaveBeenCalledTimes(1);
  });

  it('still refuses to ban the actor own account', async () => {
    await expect(banUser('self', 'self', 'reason')).rejects.toBeInstanceOf(ForbiddenError);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe('clearing moderation', () => {
  it('unsuspends: back to ACTIVE and clears the reason', async () => {
    userFindUnique.mockResolvedValue(target('SUSPENDED', 'spam'));
    userUpdate.mockResolvedValue({ id: 'target', status: 'ACTIVE', suspendedReason: null } as never);

    const result = await clearUserSuspension('actor', 'target');

    expect(result).toEqual({ id: 'target', status: 'ACTIVE', suspendedReason: null });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'target' },
      data: { status: 'ACTIVE', suspendedReason: null },
      select: SELECT,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'USER_UNSUSPENDED',
        oldValue: { status: 'SUSPENDED', suspendedReason: 'spam' },
        newValue: { status: 'ACTIVE', suspendedReason: null },
      }),
    );
  });

  it('unbans: back to ACTIVE and clears the reason', async () => {
    userFindUnique.mockResolvedValue(target('BANNED', 'fraud'));
    userUpdate.mockResolvedValue({ id: 'target', status: 'ACTIVE', suspendedReason: null } as never);

    const result = await unbanUser('actor', 'target');

    expect(result).toEqual({ id: 'target', status: 'ACTIVE', suspendedReason: null });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'USER_UNBANNED' }));
  });

  it('unbanning an already-active user is a no-op', async () => {
    userFindUnique.mockResolvedValue(target('ACTIVE', null));

    const result = await unbanUser('actor', 'target');

    expect(result).toEqual({ id: 'target', status: 'ACTIVE', suspendedReason: null });
    expect(userUpdate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

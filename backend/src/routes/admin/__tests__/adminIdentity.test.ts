import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { adminRecordId, adminUserId } from '../common';

/**
 * Which id an admin action carries.
 *
 * An admin request holds two identities at once: the `User` row behind the person, and
 * their `AdminUser` row. Only the User id may be written into an audit field —
 * `AuditLog.actorId` and `TicketMessage.senderId` both reference `User` — and passing the
 * `AdminUser.id` instead produced a foreign-key violation. `recordAudit` swallows write
 * failures by design (an audit write must never fail the action it describes), so the
 * mistake was invisible: the action succeeded and its audit row simply never existed.
 *
 * These tests pin the distinction, since the two helpers are trivially confusable and the
 * failure mode of confusing them is silence.
 */

/** A request as the auth middlewares leave it: both identities, with different ids. */
function makeReq(): Request {
  return {
    user: { id: 'user_1' },
    admin: { id: 'admin_row_1', role: 'ADMIN', permissions: [] },
  } as unknown as Request;
}

describe('adminUserId — what audit fields reference', () => {
  it('returns the User id, not the AdminUser id', () => {
    const req = makeReq();
    expect(adminUserId(req)).toBe('user_1');
    // The whole point: these are different values, and the wrong one used to be written.
    expect(adminUserId(req)).not.toBe(adminRecordId(req));
  });

  it('throws when the request carries no user, rather than returning an empty id', () => {
    expect(() => adminUserId({} as Request)).toThrow(/admin access required/i);
  });
});

describe('adminRecordId — for AdminUser-scoped work only', () => {
  it('returns the AdminUser row id', () => {
    expect(adminRecordId(makeReq())).toBe('admin_row_1');
  });

  it('throws when the request carries no admin row', () => {
    expect(() => adminRecordId({} as Request)).toThrow(/admin access required/i);
  });

  it('is the id an AdminNotification is scoped to', () => {
    // There is exactly one place that needs this rather than adminUserId: the staff
    // notification inbox, whose rows are addressed to the AdminUser row.
    const req = makeReq();
    expect(adminUserId(req)).toBe('user_1');
    expect(adminRecordId(req)).toBe('admin_row_1');
  });
});

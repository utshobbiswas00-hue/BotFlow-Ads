import { describe, expect, it } from 'vitest';
import {
  adminAccessChangeBlockedReason,
  adminDeactivationBlockedReason,
} from '../admin/lib/permissions';

/**
 * The two ways the panel could lock everybody out, refused before the click.
 *
 * The server is the authority (`assertAdminAccessSurvives`); this is the client saying so
 * up front, because a 400 with no visible reason on a button labelled "Deactivate" reads
 * as a broken panel rather than as a rule. Both sides judge the RESULTING state, and both
 * tests below exist to keep them from drifting apart.
 */
const me = [{ id: 'adm_1', role: 'SUPER_ADMIN', isActive: true }];
const twoSupers = [
  { id: 'adm_1', role: 'SUPER_ADMIN', isActive: true },
  { id: 'adm_2', role: 'SUPER_ADMIN', isActive: true },
];
const oneSuperAndAStaff = [
  { id: 'adm_1', role: 'SUPER_ADMIN', isActive: true },
  { id: 'adm_3', role: 'MODERATOR', isActive: true },
];

describe('deactivating an admin', () => {
  it('refuses your own account', () => {
    const reason = adminDeactivationBlockedReason(me[0]!, { id: 'adm_1' }, me);
    expect(reason).toMatch(/your own account/i);
  });

  it('refuses the last active SUPER_ADMIN', () => {
    const target = oneSuperAndAStaff[0]!;
    const reason = adminDeactivationBlockedReason(target, { id: 'adm_9' }, oneSuperAndAStaff);
    expect(reason).toMatch(/only active SUPER_ADMIN/i);
  });

  it('allows a SUPER_ADMIN once another one remains', () => {
    const target = twoSupers[1]!;
    expect(adminDeactivationBlockedReason(target, { id: 'adm_1' }, twoSupers)).toBeNull();
  });

  it('allows deactivating ordinary staff', () => {
    const target = oneSuperAndAStaff[1]!;
    expect(adminDeactivationBlockedReason(target, { id: 'adm_1' }, oneSuperAndAStaff)).toBeNull();
  });

  it('says nothing about an account that is already inactive', () => {
    const target = { id: 'adm_4', role: 'SUPER_ADMIN', isActive: false };
    expect(adminDeactivationBlockedReason(target, { id: 'adm_1' }, [target])).toBeNull();
  });

  it('still refuses your own account when you are not the last SUPER_ADMIN', () => {
    // Self-lockout is a separate rule from "the last one": with two SUPER_ADMINs you can
    // lock yourself out just fine, and would have to ask the other person to undo it.
    const reason = adminDeactivationBlockedReason(twoSupers[0]!, { id: 'adm_1' }, twoSupers);
    expect(reason).toMatch(/your own account/i);
  });
});

describe('changing an admin role', () => {
  it('warns when the account is your own', () => {
    const reason = adminAccessChangeBlockedReason(me[0]!, { id: 'adm_1' }, me);
    expect(reason).toMatch(/your own account/i);
  });

  it('warns about the only active SUPER_ADMIN', () => {
    const target = oneSuperAndAStaff[0]!;
    const reason = adminAccessChangeBlockedReason(target, { id: 'adm_9' }, oneSuperAndAStaff);
    expect(reason).toMatch(/only active SUPER_ADMIN/i);
  });

  it('stays out of the way for an ordinary edit', () => {
    const target = oneSuperAndAStaff[1]!;
    expect(adminAccessChangeBlockedReason(target, { id: 'adm_1' }, oneSuperAndAStaff)).toBeNull();
  });

  it('stays out of the way when another SUPER_ADMIN remains', () => {
    expect(adminAccessChangeBlockedReason(twoSupers[1]!, { id: 'adm_1' }, twoSupers)).toBeNull();
  });
});

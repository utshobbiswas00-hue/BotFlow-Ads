import { describe, expect, it } from 'vitest';
import {
  channelActionsFor,
  channelApproveAnywayOffered,
  channelApproveBlockedReason,
  channelNeedsRightsRecheck,
} from '../admin/lib/actions';

/**
 * Approve is refused unless the bot can actually post in the channel, and the panel
 * disables the button with the backend's own reason rather than letting it fail.
 *
 * The trap that follows from that: the rights snapshot is written by the
 * `my_chat_member` push, which never arrives when the webhook was misconfigured while
 * the bot was added. The snapshot then says "not an admin" while the bot very much is
 * one, APPROVE stays disabled forever, and the message told the operator the snapshot
 * "updates on its own" — which is exactly the thing that had failed.
 *
 * So the panel now offers "Re-check rights", which asks Telegram directly and lets
 * `verifyChannel` rewrite the snapshot (promoting the channel to APPROVED when the
 * rights really are there). These tests pin the two conditions that decide when it
 * appears, and that the disabled Approve points at it.
 */
const ready = { botIsAdmin: true, canPostMessages: true };
const notAdmin = { botIsAdmin: false, canPostMessages: true };
const cannotPost = { botIsAdmin: true, canPostMessages: false };

describe('when the rights snapshot needs re-asking', () => {
  it('is satisfied when the bot is an admin with post rights', () => {
    expect(channelNeedsRightsRecheck(ready)).toBe(false);
  });

  it('is offered when the bot is not an administrator', () => {
    expect(channelNeedsRightsRecheck(notAdmin)).toBe(true);
  });

  it('is offered when the bot is an admin without the post-messages right', () => {
    // Being an administrator is not enough — posting needs can_post_messages.
    expect(channelNeedsRightsRecheck(cannotPost)).toBe(true);
  });
});

describe('the disabled Approve button', () => {
  it('has no reason to give when the channel is ready', () => {
    expect(channelApproveBlockedReason({ ...ready, title: 'Crypto News' })).toBeNull();
  });

  it('names the Re-check action, instead of promising the snapshot updates on its own', () => {
    const reason = channelApproveBlockedReason({ ...notAdmin, title: 'Crypto News' });

    expect(reason).toBeTruthy();
    // The old copy promised a push that is precisely the thing that may never arrive.
    expect(reason).toMatch(/Re-check rights/);
    expect(reason).not.toMatch(/updates on its own/);
    // And it still says the other fix, for the case where the bot really is missing.
    expect(reason).toMatch(/owner/);
    expect(reason).toContain('Crypto News');
  });
});

describe('VERIFY is not status-driven', () => {
  it('is not offered by status alone, so it cannot appear twice on a row', () => {
    // The Channels page pushes it when channelNeedsRightsRecheck() says so. If it were
    // also listed per-status, a stuck PENDING row would render two identical buttons.
    for (const status of ['PENDING', 'APPROVED', 'INACTIVE', 'ATTENTION_REQUIRED', 'REJECTED', 'SUSPENDED']) {
      expect(channelActionsFor(status)).not.toContain('VERIFY');
    }
  });

  it('does not offer the override by status alone either', () => {
    for (const status of ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED']) {
      expect(channelActionsFor(status)).not.toContain('APPROVE_ANYWAY');
    }
  });

  it('still returns the actions that are status-driven', () => {
    expect(channelActionsFor('PENDING')).toEqual(expect.arrayContaining(['APPROVE', 'REJECT', 'SUSPEND']));
    expect(channelActionsFor('APPROVED')).toEqual(expect.arrayContaining(['SUSPEND']));
  });
});

describe('the operator override', () => {
  it('is offered where APPROVE is refused and the channel is waiting for review', () => {
    expect(channelApproveAnywayOffered({ ...notAdmin, status: 'PENDING' })).toBe(true);
    expect(channelApproveAnywayOffered({ ...cannotPost, status: 'PENDING' })).toBe(true);
  });

  it('is not offered when the bot can post, because there is no refusal to override', () => {
    expect(channelApproveAnywayOffered({ ...ready, status: 'PENDING' })).toBe(false);
  });

  it('is not offered for a channel that is not waiting for review', () => {
    // A suspended or rejected channel is dealt with by REACTIVATE, not by approving over
    // the top of a decision somebody already made.
    for (const status of ['APPROVED', 'REJECTED', 'SUSPENDED', 'INACTIVE']) {
      expect(channelApproveAnywayOffered({ ...notAdmin, status })).toBe(false);
    }
  });
});

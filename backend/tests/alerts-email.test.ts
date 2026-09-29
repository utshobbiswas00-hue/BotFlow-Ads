import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db/prisma';
import { ValidationError } from '../src/utils/errors';

// The queue producers are not under test here, and importing them would open a
// real Redis connection during the suite. The EMAIL ATTEMPT we assert on is
// the enqueueEmail call — the actual send happens in the notification worker.
const queue = vi.hoisted(() => ({
  enqueuePublishAd: vi.fn(async () => 'queued' as string | null),
  enqueueNotification: vi.fn(async () => undefined),
  enqueueEmail: vi.fn(
    async (
      _payload: { to: string; subject: string; html: string; text?: string; notificationId?: string; userId?: string },
      _delayMs?: number,
    ) => undefined,
  ),
}));
vi.mock('../src/queues/producers', () => queue);

const { sendMail } = await import('../src/utils/mailer');
const {
  setUserEmail,
  sendVerificationEmail,
  verifyEmailToken,
  getEmailState,
  sendTransactionalEmail,
} = await import('../src/services/email.service');
const { checkBudgetAlerts, notifyEarningsAvailable, recordLoginAndAlert } = await import(
  '../src/services/alert.service'
);
const { createNotification } = await import('../src/services/notification.service');
const { resetDatabase, createUser, createCampaign, setTestSettings } = await import('./helpers/fixtures');

/**
 * EMAIL CHANNEL + USER-ALERT FAMILIES.
 *
 *   1. Budget alerts — BUDGET_LOW fires exactly once per campaign per
 *      threshold as spend crosses 50/25/10/5%, and re-checking the same spend
 *      adds nothing (the audit trail is the "already fired" state).
 *   2. Earnings available — the publisher is told, in-app and by email, when
 *      their money becomes spendable.
 *   3. New-device logins — first sight of an IP is a SECURITY_ALERT (once);
 *      the same IP again is quiet.
 *   4. Email address lifecycle — one account per address, verify with a
 *      single-use 24h token.
 *   5. Mailer discipline — with email disabled (the default) sendMail is a
 *      logged no-op that never throws.
 */

describe('alerts + email channel', () => {
  beforeEach(async () => {
    await resetDatabase();
    queue.enqueueEmail.mockClear();
    queue.enqueueNotification.mockClear();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /* ---------------- budget alerts ---------------- */

  describe('budget alerts', () => {
    it('fires each threshold exactly once as spend rises, and re-runs add nothing', async () => {
      const advertiser = await createUser();
      const campaign = await createCampaign(advertiser.id, { budgetTotalCents: 10_000, budgetSpentCents: 0 });

      const budgetLow = () => prisma.notification.count({ where: { userId: advertiser.id, type: 'BUDGET_LOW' } });

      // 0% — nothing has crossed yet.
      const atZero = await checkBudgetAlerts(campaign.id);
      expect(atZero.fired).toEqual([]);
      expect(await budgetLow()).toBe(0);

      // 60% — every default threshold (50/25/10/5) is crossed at once,
      // and each fires exactly once.
      await prisma.campaign.update({ where: { id: campaign.id }, data: { budgetSpentCents: 6_000 } });
      const atSixty = await checkBudgetAlerts(campaign.id);
      expect([...atSixty.fired].sort((a, b) => a - b)).toEqual([5, 10, 25, 50]);
      expect(await budgetLow()).toBe(4);

      const rows = await prisma.notification.findMany({ where: { userId: advertiser.id, type: 'BUDGET_LOW' } });
      expect(rows.map((r) => (r.data as { threshold: number }).threshold).sort((a, b) => a - b)).toEqual([
        5, 10, 25, 50,
      ]);

      // 80% and 95% — no NEW threshold is crossed, so nothing new fires.
      await prisma.campaign.update({ where: { id: campaign.id }, data: { budgetSpentCents: 8_000 } });
      await checkBudgetAlerts(campaign.id);
      await prisma.campaign.update({ where: { id: campaign.id }, data: { budgetSpentCents: 9_500 } });
      const atNinetyFive = await checkBudgetAlerts(campaign.id);
      expect(atNinetyFive.fired).toEqual([]);
      expect(await budgetLow()).toBe(4);

      // Re-running at the same spend is a no-op — idempotent by construction.
      await checkBudgetAlerts(campaign.id);
      expect(await budgetLow()).toBe(4);
    });

    it('reads the thresholds from the settings table', async () => {
      await setTestSettings({ budget_alert_thresholds: [90, 30] });
      const advertiser = await createUser();
      const campaign = await createCampaign(advertiser.id, { budgetTotalCents: 10_000, budgetSpentCents: 0 });

      await prisma.campaign.update({ where: { id: campaign.id }, data: { budgetSpentCents: 6_000 } });
      const atSixty = await checkBudgetAlerts(campaign.id);
      expect(atSixty.fired).toEqual([30]);

      await prisma.campaign.update({ where: { id: campaign.id }, data: { budgetSpentCents: 9_500 } });
      const atNinetyFive = await checkBudgetAlerts(campaign.id);
      expect(atNinetyFive.fired).toEqual([90]);

      expect(await prisma.notification.count({ where: { userId: advertiser.id, type: 'BUDGET_LOW' } })).toBe(2);
    });

    it('never fires a threshold above 100, even when configured that way', async () => {
      await setTestSettings({ budget_alert_thresholds: [150, 50] });
      const advertiser = await createUser();
      const campaign = await createCampaign(advertiser.id, { budgetTotalCents: 10_000, budgetSpentCents: 0 });

      await prisma.campaign.update({ where: { id: campaign.id }, data: { budgetSpentCents: 10_000 } });
      const result = await checkBudgetAlerts(campaign.id);
      expect(result.fired).toEqual([50]);
      expect(result.percent).toBe(100);
    });

    it('does nothing for a campaign with no usable budget', async () => {
      const advertiser = await createUser();
      const campaign = await createCampaign(advertiser.id, { budgetTotalCents: 0, budgetSpentCents: 0 });
      const result = await checkBudgetAlerts(campaign.id);
      expect(result.fired).toEqual([]);
      expect(await prisma.notification.count({ where: { userId: advertiser.id } })).toBe(0);
    });
  });

  /* ---------------- earnings available ---------------- */

  describe('earnings available', () => {
    it('creates the notification and exactly one email attempt', async () => {
      const publisher = await createUser();
      await prisma.user.update({ where: { id: publisher.id }, data: { email: 'pub@example.com' } });

      await notifyEarningsAvailable(publisher.id, 1_234, { earningIds: ['e1', 'e2'] });

      const rows = await prisma.notification.findMany({
        where: { userId: publisher.id, type: 'EARNINGS_AVAILABLE' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].data).toMatchObject({ amountCents: 1_234, earningIds: ['e1', 'e2'] });

      // The email attempt: one enqueue to the user's address. The fan-out is
      // the ONLY email path, so there is exactly one.
      expect(queue.enqueueEmail).toHaveBeenCalledTimes(1);
      const payload = queue.enqueueEmail.mock.calls[0][0];
      expect(payload).toMatchObject({ to: 'pub@example.com', userId: publisher.id });
      expect(payload.subject).toContain('$12.34');
    });

    it('still records the notification when the user has no email address', async () => {
      const publisher = await createUser();

      await notifyEarningsAvailable(publisher.id, 500);

      expect(await prisma.notification.count({ where: { userId: publisher.id, type: 'EARNINGS_AVAILABLE' } })).toBe(1);
      expect(queue.enqueueEmail).not.toHaveBeenCalled();
    });
  });

  /* ---------------- new-device login alerts ---------------- */

  describe('new-device login alerts', () => {
    const UA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Telegram/10.8';

    it('flags the first sign-in from an IP, alerts once, and stays quiet from the same IP', async () => {
      const user = await createUser();
      await prisma.user.update({ where: { id: user.id }, data: { email: 'login@example.com' } });

      const first = await recordLoginAndAlert(user.id, { ip: '203.0.113.7', userAgent: UA_IOS, country: 'US' });
      expect(first.isNewDevice).toBe(true);
      expect(first.alerted).toBe(true);

      const event = await prisma.loginEvent.findFirst({ where: { userId: user.id } });
      expect(event).not.toBeNull();
      expect(event?.isNewDevice).toBe(true);
      expect(event?.alertedAt).not.toBeNull();
      expect(event?.deviceLabel).toBe('Telegram · iOS');
      // The raw IP is never stored — only its salted hash.
      expect(event?.ipHash).toBeTruthy();
      expect(event?.ipHash).not.toContain('203.0.113.7');

      const securityAlerts = () =>
        prisma.notification.count({ where: { userId: user.id, type: 'SECURITY_ALERT' } });
      expect(await securityAlerts()).toBe(1);
      expect(queue.enqueueEmail).toHaveBeenCalledTimes(1);
      expect(queue.enqueueEmail.mock.calls[0][0].to).toBe('login@example.com');

      // Same IP again: a known device, no second alert.
      const again = await recordLoginAndAlert(user.id, { ip: '203.0.113.7', userAgent: UA_IOS, country: 'US' });
      expect(again.isNewDevice).toBe(false);
      expect(again.alerted).toBe(false);
      expect(await securityAlerts()).toBe(1);
      // Both sign-ins are still recorded in the login history.
      expect(await prisma.loginEvent.count({ where: { userId: user.id } })).toBe(2);
      expect(queue.enqueueEmail).toHaveBeenCalledTimes(1);

      // A genuinely new IP alerts again — once.
      const other = await recordLoginAndAlert(user.id, {
        ip: '198.51.100.9',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
      });
      expect(other.isNewDevice).toBe(true);
      expect(other.alerted).toBe(true);
      expect(await securityAlerts()).toBe(2);
    });

    it('records the login but does not alert when security alerts are switched off', async () => {
      await setTestSettings({ security_alerts_enabled: false });
      const user = await createUser();
      await prisma.user.update({ where: { id: user.id }, data: { email: 'quiet@example.com' } });

      const first = await recordLoginAndAlert(user.id, { ip: '203.0.113.99', userAgent: UA_IOS, country: 'US' });
      expect(first.isNewDevice).toBe(true);
      expect(first.alerted).toBe(false);
      expect(await prisma.loginEvent.count({ where: { userId: user.id } })).toBe(1);
      expect(await prisma.notification.count({ where: { userId: user.id, type: 'SECURITY_ALERT' } })).toBe(0);
      expect(queue.enqueueEmail).not.toHaveBeenCalled();
    });
  });

  /* ---------------- email address lifecycle ---------------- */

  describe('email address lifecycle', () => {
    it('stores the address lowercased, queues the link, and blocks a second account from taking it', async () => {
      const a = await createUser();
      const b = await createUser();

      const res = await setUserEmail(a.id, 'Take.This@Example.com ');
      expect(res).toMatchObject({ email: 'take.this@example.com', verified: false, verificationSent: true });

      const row = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.email).toBe('take.this@example.com');
      expect(row.emailVerifiedAt).toBeNull();
      expect(row.emailVerifyToken).toBeTruthy();
      expect(row.emailVerifySentAt).not.toBeNull();
      expect(queue.enqueueEmail).toHaveBeenCalledTimes(1);
      expect(queue.enqueueEmail.mock.calls[0][0].to).toBe('take.this@example.com');

      // A second account — even with different casing — cannot take the address.
      await expect(setUserEmail(b.id, 'TAKE.THIS@example.com')).rejects.toBeInstanceOf(ValidationError);
      const bRow = await prisma.user.findUniqueOrThrow({ where: { id: b.id } });
      expect(bRow.email).toBeNull();

      // …but the owner can re-set their own address (which re-sends the link).
      const again = await setUserEmail(a.id, 'take.this@example.com');
      expect(again).toMatchObject({ email: 'take.this@example.com', verificationSent: true });

      // Invalid input is rejected up front.
      await expect(setUserEmail(a.id, 'not-an-email')).rejects.toBeInstanceOf(ValidationError);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).email).toBe('take.this@example.com');
    });

    it('verifies with a fresh token, rejects unknown tokens, is single-use, and expires after 24h', async () => {
      const a = await createUser();
      await setUserEmail(a.id, 'verify@example.com');
      const before = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
      expect(before.emailVerifyToken).toBeTruthy();

      await expect(verifyEmailToken('definitely-not-a-real-token')).rejects.toBeInstanceOf(ValidationError);

      const result = await verifyEmailToken(before.emailVerifyToken as string);
      expect(result).toMatchObject({ userId: a.id, email: 'verify@example.com' });
      const after = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
      expect(after.emailVerifiedAt).not.toBeNull();
      expect(after.emailVerifyToken).toBeNull();
      expect(after.emailVerifySentAt).toBeNull();
      expect((await getEmailState(a.id)).verified).toBe(true);

      // Single-use: replaying the same token fails.
      await expect(verifyEmailToken(before.emailVerifyToken as string)).rejects.toBeInstanceOf(ValidationError);

      // A token older than 24h is expired, not just unknown.
      await sendVerificationEmail(a.id);
      const resent = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
      await prisma.user.update({
        where: { id: a.id },
        data: { emailVerifySentAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      await expect(verifyEmailToken(resent.emailVerifyToken as string)).rejects.toThrow(/expired/i);
    });

    it('reports the current email state', async () => {
      const a = await createUser();
      expect(await getEmailState(a.id)).toMatchObject({
        email: null,
        verified: false,
        verificationPending: false,
        emailOptIn: true,
      });

      await setUserEmail(a.id, 'state@example.com');
      expect(await getEmailState(a.id)).toMatchObject({
        email: 'state@example.com',
        verified: false,
        verificationPending: true,
      });
    });

    it('skips non-transactional mail for opted-out users but still sends transactional mail', async () => {
      const user = await createUser();
      await prisma.user.update({
        where: { id: user.id },
        data: { email: 'optout@example.com', emailOptIn: false },
      });

      const skipped = await sendTransactionalEmail({
        userId: user.id,
        subject: 'Your weekly digest',
        html: '<p>digest</p>',
        transactional: false,
      });
      expect(skipped.queued).toBe(false);
      expect(skipped.reason).toBe('user opted out of email');
      expect(queue.enqueueEmail).not.toHaveBeenCalled();

      const sent = await sendTransactionalEmail({
        userId: user.id,
        subject: 'Security alert for your BotFlow account',
        html: '<p>alert</p>',
      });
      expect(sent.queued).toBe(true);
      expect(queue.enqueueEmail).toHaveBeenCalledTimes(1);
    });
  });

  /* ---------------- notification fan-out & mailer discipline ---------------- */

  describe('notification fan-out and mailer', () => {
    it('queues a transactional email for the fan-out types and not for the rest', async () => {
      const user = await createUser();
      await prisma.user.update({ where: { id: user.id }, data: { email: 'fanout@example.com' } });

      await createNotification({
        userId: user.id,
        type: 'INVOICE_READY',
        title: 'Invoice BFA-2026-09-0001 is ready',
        body: 'Your invoice is ready to download.',
      });
      expect(queue.enqueueEmail).toHaveBeenCalledTimes(1);
      expect(queue.enqueueEmail.mock.calls[0][0].to).toBe('fanout@example.com');

      // BUDGET_LOW and friends stay chat-only.
      await createNotification({ userId: user.id, type: 'BUDGET_LOW', title: 'Budget low', body: '60% used.' });
      await createNotification({ userId: user.id, type: 'SYSTEM', title: 'Hello', body: 'World' });
      expect(queue.enqueueEmail).toHaveBeenCalledTimes(1);
      expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(3);
    });

    it('does not throw and reports sent:false while email is disabled (the default)', async () => {
      const result = await sendMail({ to: 'x@example.com', subject: 'Hi', html: '<p>hi</p>', text: 'hi' });
      expect(result).toEqual({ sent: false, reason: 'email disabled' });
    });

    it('reports a missing transport — still without throwing — when email is enabled but nothing is configured', async () => {
      await setTestSettings({ email_enabled: true });
      const result = await sendMail({ to: 'x@example.com', subject: 'Hi', html: '<p>hi</p>' });
      expect(result).toEqual({ sent: false, reason: 'no transport available' });
    });
  });
});

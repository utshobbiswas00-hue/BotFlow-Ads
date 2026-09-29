import { prisma, Prisma } from '../db/prisma';
import { env } from '../config/env';
import { childLogger } from '../config/logger';
import { setEmailSchema } from '@botflow/shared';
import { enqueueEmail } from '../queues/producers';
import { NotFoundError, ValidationError } from '../utils/errors';
import { randomToken } from '../utils/crypto';
import { notificationEmailHtml } from '../utils/mailer';

/**
 * Email service: templates, queueing and the address lifecycle
 * (set → verify → verified).
 *
 * Mirrors the notification.service style: the DB write is the source of truth,
 * the email rides on the queue behind it, and nothing here may take down the
 * business operation that asked for the mail.
 */

const log = childLogger('email');

/** Verification links are single-use and expire after this many hours. */
const VERIFY_TOKEN_TTL_HOURS = 24;

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

export interface EmailQueueResult {
  queued: boolean;
  reason?: string;
}

export function formatCents(cents: number): string {
  // Exact integer arithmetic — never route cents through a binary float
  // (Math.abs(cents) / 100 + toFixed(2)) which can be off by a cent for large
  // values. Cents are always whole minor units.
  const value = Math.round(cents);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  return `${sign}$${whole}.${fraction}`;
}

/* ------------------------------------------------------------------
 *  Templates — plain and short; every interpolated value is escaped
 *  by notificationEmailHtml.
 * ------------------------------------------------------------------ */

/** Publisher money has finished its hold period and can be withdrawn. */
export function earningsAvailableEmail(amountCents: number, earningIds?: string[]): EmailTemplate {
  const amount = formatCents(amountCents);
  const subject = `${amount} of your earnings are ready to withdraw`;
  const lines = [
    `Earnings of ${amount} have finished their hold period and are now available for withdrawal.`,
  ];
  if (earningIds?.length) lines.push(`Earnings: ${earningIds.join(', ')}`);
  lines.push('Open BotFlow Ads to withdraw — the money stays available until you do.');
  const text = lines.join('\n\n');
  return { subject, text, html: notificationEmailHtml(subject, text) };
}

/** An advertiser's campaign has crossed one of its budget alert thresholds. */
export function budgetLowEmail(campaignName: string, threshold: number, percent: number): EmailTemplate {
  const subject = `Campaign "${campaignName}" has used ${percent}% of its budget`;
  const text =
    `Your campaign "${campaignName}" has consumed ${percent}% of its total budget, ` +
    `past the ${threshold}% alert level.\n\n` +
    'You can pause it, lower its spend or top up the budget from the campaign page.';
  return { subject, text, html: notificationEmailHtml(subject, text) };
}

/**
 * A security-relevant event (new-device sign-in, withdrawal request, …).
 * `summary` is the one-liner a user must understand at a glance; `detail`
 * carries the context (device, location, amount) — never a raw IP.
 */
export function securityAlertEmail(input: { summary: string; detail?: string }): EmailTemplate {
  const subject = 'Security alert for your BotFlow account';
  const lines = [input.summary];
  if (input.detail) lines.push(input.detail);
  lines.push(
    'If this was you, no action is needed. If it was NOT you, open the app and contact support immediately, and consider withdrawing any available balance.',
  );
  const text = lines.join('\n\n');
  return { subject, text, html: notificationEmailHtml(subject, text) };
}

/** An advertiser invoice has been issued for a billing period. */
export function invoiceReadyEmail(input: { invoiceNumber: string; amountCents: number; periodLabel?: string }): EmailTemplate {
  const amount = formatCents(input.amountCents);
  const subject = `Invoice ${input.invoiceNumber} for ${amount} is ready`;
  const text =
    `Your invoice ${input.invoiceNumber}${input.periodLabel ? ` for ${input.periodLabel}` : ''} ` +
    `totaling ${amount} is ready to download from the Billing page of the app.`;
  return { subject, text, html: notificationEmailHtml(subject, text) };
}

/**
 * Confirmation link for a newly added/changed address.
 * The link is meant to open the Mini App (all /api routes require Telegram
 * auth): the app parses `token` and posts it to POST /api/me/email/verify.
 */
export function verifyEmailEmail(email: string, link: string): EmailTemplate {
  const subject = 'Verify your email address for BotFlow Ads';
  const text =
    `We added ${email} to your BotFlow Ads account.\n\n` +
    `Confirm it is yours by opening this link (valid for ${VERIFY_TOKEN_TTL_HOURS} hours):\n${link}\n\n` +
    'If you did not request this, you can safely ignore this email.';
  return { subject, text, html: notificationEmailHtml(subject, text) };
}

/* ------------------------------------------------------------------
 *  Queueing
 * ------------------------------------------------------------------ */

export interface SendTransactionalEmailInput {
  userId: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * Defaults to true. TRANSACTIONAL mail — invoices, security alerts,
   * earnings, verification — is part of the account record and must reach
   * the user even if they opted out of non-transactional mail, so it IGNORES
   * `emailOptIn` by design. Pass `transactional: false` for digests and
   * product mail; that path honours the opt-out.
   */
  transactional?: boolean;
}

/**
 * Queue a transactional email to the user's address. Never throws: no
 * address, an opted-out recipient or a queue failure all resolve to
 * `{ queued: false, reason }`.
 */
export async function sendTransactionalEmail(input: SendTransactionalEmailInput): Promise<EmailQueueResult> {
  try {
    const transactional = input.transactional ?? true;

    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, email: true, emailOptIn: true },
    });
    if (!user?.email) return { queued: false, reason: 'no email address on account' };
    if (!transactional && !user.emailOptIn) return { queued: false, reason: 'user opted out of email' };

    await enqueueEmail({
      to: user.email,
      subject: input.subject,
      html: input.html,
      text: input.text,
      userId: user.id,
    });
    return { queued: true };
  } catch (err) {
    log.error({ err, userId: input.userId, subject: input.subject }, 'failed to queue email');
    return { queued: false, reason: (err as Error).message };
  }
}

/* ------------------------------------------------------------------
 *  Address lifecycle
 * ------------------------------------------------------------------ */

function appBaseUrl(): string {
  const base = process.env.APP_URL || env.APP_URL || 'https://botflow-ads.local';
  return base.replace(/\/+$/, '');
}

/**
 * Generate a verification token, store it on the user and email the link.
 * Re-runnable: a new token supersedes the old one. Never throws.
 */
export async function sendVerificationEmail(userId: string): Promise<EmailQueueResult> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!user?.email) return { queued: false, reason: 'no email address on account' };

    const token = randomToken(32);
    const link = `${appBaseUrl()}/email/verify?token=${token}`;

    await prisma.user.update({
      where: { id: userId },
      data: { emailVerifyToken: token, emailVerifySentAt: new Date() },
    });

    const t = verifyEmailEmail(user.email, link);
    return await sendTransactionalEmail({
      userId,
      subject: t.subject,
      html: t.html,
      text: t.text,
    });
  } catch (err) {
    log.error({ err, userId }, 'failed to send verification email');
    return { queued: false, reason: (err as Error).message };
  }
}

/**
 * Complete verification. Unknown and expired (older than 24h) tokens are
 * rejected with a plain-language error the UI can show as-is.
 */
export async function verifyEmailToken(token: string): Promise<{ userId: string; email: string }> {
  const clean = (token ?? '').trim();
  if (!clean) throw new ValidationError('A verification token is required.');

  const user = await prisma.user.findFirst({
    where: { emailVerifyToken: clean },
    select: { id: true, email: true, emailVerifySentAt: true },
  });

  if (!user || !user.email) {
    throw new ValidationError('This verification link is invalid or has already been used.');
  }

  const ageMs = user.emailVerifySentAt ? Date.now() - user.emailVerifySentAt.getTime() : Number.POSITIVE_INFINITY;
  if (ageMs > VERIFY_TOKEN_TTL_HOURS * 60 * 60 * 1000) {
    throw new ValidationError('This verification link has expired. Please request a new one from Settings.');
  }

  // Single-use: the token is cleared in the same write that stamps verified.
  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerifiedAt: new Date(), emailVerifyToken: null, emailVerifySentAt: null },
  });

  log.info({ userId: user.id }, 'email address verified');
  return { userId: user.id, email: user.email };
}

/**
 * Set (or change) the account email: validate, normalise, refuse addresses
 * owned by another account, drop the old verified state and send the
 * verification link. The verification email is best-effort — a mail outage
 * must not block the address change; the user can resend from Settings.
 */
export async function setUserEmail(
  userId: string,
  email: string,
): Promise<{ email: string; verified: false; verificationSent: boolean }> {
  // Trim before validating: zod's email check rejects surrounding
  // whitespace, but a caller (or a paste) may carry it.
  const parsed = setEmailSchema.safeParse({ email: (email ?? '').trim() });
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'Enter a valid email address');
  }
  const normalised = parsed.data.email.toLowerCase();

  // Pre-check for a plain-language message; the P2002 catch below covers the
  // race where two accounts claim the same address at the same moment.
  const existing = await prisma.user.findUnique({
    where: { email: normalised },
    select: { id: true },
  });
  if (existing && existing.id !== userId) {
    throw new ValidationError('This email address is already in use by another account.');
  }

  try {
    // A changed address must never inherit the old address's verified state.
    await prisma.user.update({
      where: { id: userId },
      data: {
        email: normalised,
        emailVerifiedAt: null,
        emailVerifyToken: null,
        emailVerifySentAt: null,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ValidationError('This email address is already in use by another account.');
    }
    throw err;
  }

  const verification = await sendVerificationEmail(userId);
  return { email: normalised, verified: false, verificationSent: verification.queued };
}

/** Current email state for the Settings page. */
export async function getEmailState(
  userId: string,
): Promise<{
  email: string | null;
  verified: boolean;
  verificationPending: boolean;
  emailOptIn: boolean;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerifiedAt: true, emailVerifyToken: true, emailVerifySentAt: true, emailOptIn: true },
  });
  if (!user) throw new NotFoundError('User');

  const pending =
    user.emailVerifyToken !== null &&
    user.emailVerifySentAt !== null &&
    Date.now() - user.emailVerifySentAt.getTime() <= VERIFY_TOKEN_TTL_HOURS * 60 * 60 * 1000;

  return {
    email: user.email,
    verified: user.emailVerifiedAt !== null,
    verificationPending: pending,
    emailOptIn: user.emailOptIn,
  };
}

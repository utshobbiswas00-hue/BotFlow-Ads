import type { Request } from 'express';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { childLogger } from '../config/logger';
import { SETTING_KEYS } from '../config/constants';
import { getArraySetting, getBoolSetting } from './settings.service';
import { createNotification } from './notification.service';
import { budgetLowEmail, earningsAvailableEmail, formatCents, securityAlertEmail } from './email.service';
import { recordAudit } from './audit.service';
import { hashIp, sha256 } from '../utils/crypto';

/**
 * User-alert families. These are PURE service functions: the money paths
 * (escrow, campaign charging, delivery, payout sweeps) call them and nothing
 * here knows those paths exist. Every function is best-effort by
 * construction — an alert failure must never fail the operation that caused
 * the alert.
 */

const log = childLogger('alerts');

/** Code-level fallback for the threshold setting (matches SETTING_DEFAULTS). */
const DEFAULT_BUDGET_THRESHOLDS = [50, 25, 10, 5];

/* ------------------------------------------------------------------
 *  Budget alerts
 * ------------------------------------------------------------------ */

export interface BudgetAlertResult {
  campaignId: string;
  /** Consumed percentage of the budget, to one decimal. */
  percent: number;
  /** Thresholds that fired on THIS call (empty when nothing was new). */
  fired: number[];
}

/**
 * Fire a BUDGET_LOW notification for every alert threshold the campaign has
 * just crossed — exactly ONCE per campaign per threshold.
 *
 * WHERE THE "ALREADY FIRED" STATE LIVES
 * There is no dedicated column for which thresholds have fired, so the
 * campaign's existing audit trail IS the state: each firing appends one
 * `CAMPAIGN_BUDGET_ALERT` row (targetType CAMPAIGN, newValue
 * `{ threshold, percent }`), and the prior rows are read back before
 * deciding what is new. The audit log is append-only, already exists for
 * "what happened to this campaign" questions, and needs no schema change —
 * at the cost of one read of the campaign's alert rows per check, which is
 * negligible next to the write it guards.
 *
 * Call this whenever budgetSpentCents changes (charge, release, refund).
 * It is idempotent: re-running at the same spend adds nothing.
 */
export async function checkBudgetAlerts(campaignId: string): Promise<BudgetAlertResult> {
  // Documented contract: best-effort. This is meant to run from the money
  // paths (budget charge/release) and must never fail the operation that
  // caused the alert, so any failure resolves to an empty result instead of
  // propagating to the caller.
  try {
    return await runBudgetAlerts(campaignId);
  } catch (err) {
    log.error({ err, campaignId }, 'budget alert check failed (non-fatal)');
    return { campaignId, percent: 0, fired: [] };
  }
}

async function runBudgetAlerts(campaignId: string): Promise<BudgetAlertResult> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      advertiserId: true,
      name: true,
      budgetTotalCents: true,
      budgetSpentCents: true,
    },
  });
  if (!campaign || campaign.budgetTotalCents <= 0) return { campaignId, percent: 0, fired: [] };

  const percent = Math.round((campaign.budgetSpentCents / campaign.budgetTotalCents) * 1000) / 10;
  if (campaign.budgetSpentCents <= 0) return { campaignId, percent, fired: [] };

  // A threshold above 100 can never be crossed by real spend — never fire it.
  const thresholds = (
    await getArraySetting<number>(SETTING_KEYS.BUDGET_ALERT_THRESHOLDS, DEFAULT_BUDGET_THRESHOLDS)
  )
    .filter((t) => Number.isFinite(t) && t > 0 && t <= 100)
    .sort((a, b) => b - a);

  const prior = await prisma.auditLog.findMany({
    where: { action: 'CAMPAIGN_BUDGET_ALERT', targetType: 'CAMPAIGN', targetId: campaignId },
    select: { newValue: true },
    // One row is appended per threshold per campaign, so this is small; the
    // bound just guarantees it can never grow without limit.
    take: 100,
  });
  const alreadyFired = new Set<number>(
    prior.flatMap((row) => {
      const value = row.newValue as { threshold?: unknown } | null;
      return typeof value?.threshold === 'number' ? [value.threshold] : [];
    }),
  );

  const crossed = thresholds.filter((t) => percent >= t && !alreadyFired.has(t));
  if (!crossed.length) return { campaignId, percent, fired: [] };

  for (const threshold of crossed) {
    // Record the state BEFORE notifying: if the notification write fails,
    // the audit row still exists and the threshold will not fire again on
    // the next spend update. One missed alert is cheaper than a duplicate
    // one. recordAudit itself never throws.
    await recordAudit({
      actorType: 'SYSTEM',
      action: 'CAMPAIGN_BUDGET_ALERT',
      targetType: 'CAMPAIGN',
      targetId: campaignId,
      newValue: { threshold, percent },
    });

    const t = budgetLowEmail(campaign.name, threshold, percent);
    await createNotification({
      userId: campaign.advertiserId,
      type: 'BUDGET_LOW',
      title: t.subject,
      body: t.text,
      data: { campaignId, threshold, percent },
      link: `/campaigns/${campaignId}`,
    });
  }

  log.info({ campaignId, percent, fired: crossed }, 'budget alerts fired');
  return { campaignId, percent, fired: crossed };
}

/* ------------------------------------------------------------------
 *  Earnings available
 * ------------------------------------------------------------------ */

/**
 * Tell a publisher their money finished its hold period and can be
 * withdrawn. Creates the EARNINGS_AVAILABLE notification; the transactional
 * email rides on createNotification's email fan-out (EARNINGS_AVAILABLE is
 * one of the types it emails), so the user gets exactly one email, not two.
 */
export async function notifyEarningsAvailable(
  userId: string,
  amountCents: number,
  options: { earningIds?: string[] } = {},
): Promise<void> {
  const t = earningsAvailableEmail(amountCents, options.earningIds);
  await createNotification({
    userId,
    type: 'EARNINGS_AVAILABLE',
    title: t.subject,
    body: t.text,
    data: { amountCents, earningIds: options.earningIds ?? null },
    link: '/benefits',
  });
}

/* ------------------------------------------------------------------
 *  Security alerts — new-device logins & withdrawal requests
 * ------------------------------------------------------------------ */

export interface LoginAlertInput {
  ip: string;
  userAgent?: string | null;
  country?: string | null;
}

export interface LoginAlertResult {
  loginEventId: string;
  isNewDevice: boolean;
  alerted: boolean;
}

/** Coarse, human-readable label from the raw user agent. */
function deviceLabelFromUserAgent(ua?: string | null): string {
  if (!ua) return 'Unknown device';
  const s = ua.toLowerCase();
  const surface = s.includes('telegram') ? 'Telegram' : 'Web app';
  if (s.includes('iphone') || s.includes('ipad') || s.includes('ios')) return `${surface} · iOS`;
  if (s.includes('android')) return `${surface} · Android`;
  if (s.includes('windows')) return `${surface} · Windows`;
  if (s.includes('macintosh') || s.includes('mac os')) return `${surface} · macOS`;
  if (s.includes('linux')) return `${surface} · Linux`;
  return surface;
}

/**
 * Record a sign-in and, when it comes from a device this user has never
 * used before, raise a SECURITY_ALERT (notification + transactional email
 * via the createNotification fan-out) and stamp the event.
 *
 * Hashing choices: the IP reuses the platform's existing `hashIp`
 * (SHA-256 salted with JWT_SECRET) so login events and click events
 * fingerprint the same way; the user agent is SHA-256 salted with
 * ENCRYPTION_KEY because common UA strings are low-entropy and the
 * unsalted click-side `hashUserAgent` would be trivially rainbow-tableable
 * for a column we now use to detect novel devices. Raw IP / UA are never
 * stored.
 */
export async function recordLoginAndAlert(userId: string, input: LoginAlertInput): Promise<LoginAlertResult> {
  const ipHash = hashIp(input.ip || 'unknown');
  const userAgentHash = input.userAgent ? sha256(`${input.userAgent}:${env.ENCRYPTION_KEY}`) : null;
  const deviceLabel = deviceLabelFromUserAgent(input.userAgent);

  const seen = await prisma.loginEvent.findFirst({
    where: { userId, ipHash },
    select: { id: true },
  });
  const isNewDevice = !seen;

  // Race note: two CONCURRENT first sign-ins from one brand-new IP can both
  // see "unseen" and both alert. That window only opens during a genuine
  // fresh-device login burst, where a duplicated alert is harmless — and a
  // unique (userId, ipHash) index would be wrong, because repeat sign-ins
  // from the same device are the norm, not the exception.
  const loginEvent = await prisma.loginEvent.create({
    data: {
      userId,
      ipHash,
      userAgentHash,
      deviceLabel,
      country: input.country ?? null,
      isNewDevice,
    },
  });

  if (!isNewDevice || !(await getBoolSetting(SETTING_KEYS.SECURITY_ALERTS_ENABLED, true))) {
    return { loginEventId: loginEvent.id, isNewDevice, alerted: false };
  }

  const t = securityAlertEmail({
    summary: 'We noticed a sign-in from a new device.',
    detail: `Device: ${deviceLabel}${input.country ? ` · Location: ${input.country}` : ''}`,
  });
  await createNotification({
    userId,
    type: 'SECURITY_ALERT',
    title: t.subject,
    body: t.text,
    data: { deviceLabel, country: input.country ?? null, ipHash, loginEventId: loginEvent.id },
    link: '/settings',
  });

  // Stamp the event that produced the alert, so support can see the
  // decision on the row itself. The stamp is cosmetic to the security
  // decision (which is based on (userId, ipHash) novelty) and must not fail
  // the alert path if it errors.
  await prisma.loginEvent
    .update({ where: { id: loginEvent.id }, data: { alertedAt: new Date() } })
    .catch((err) => log.warn({ err, loginEventId: loginEvent.id }, 'could not stamp login event alertedAt'));

  return { loginEventId: loginEvent.id, isNewDevice, alerted: true };
}

/**
 * Fire-and-forget wrapper for the auth middleware: records the sign-in and
 * raises the new-device alert if due. Strictly non-blocking — it never
 * throws and never delays the request, so authentication cannot fail
 * because of it.
 */
export function trackSession(userId: string, req: Pick<Request, 'ip' | 'headers'>): void {
  const ip = req.ip || 'unknown';
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
  const rawCountry = req.headers['cf-ipcountry'];
  const country = typeof rawCountry === 'string' && rawCountry ? rawCountry : undefined;

  void recordLoginAndAlert(userId, { ip, userAgent, country }).catch((err) => {
    log.warn({ err, userId }, 'login tracking failed (non-blocking)');
  });
}

/**
 * A withdrawal REQUEST is the moment a compromised account is most likely
 * to be caught: approval/payment notifications land later, after the money
 * has already been committed. So the request itself raises a SECURITY_ALERT
 * (in-app + transactional email via the createNotification fan-out).
 */
export async function notifyWithdrawalRequested(
  userId: string,
  details: { amountCents: number; method: string },
): Promise<void> {
  const t = securityAlertEmail({
    summary: 'A withdrawal was requested from your account.',
    detail: `Amount: ${formatCents(details.amountCents)} · Method: ${details.method}`,
  });
  await createNotification({
    userId,
    type: 'SECURITY_ALERT',
    title: t.subject,
    body: t.text,
    data: { amountCents: details.amountCents, method: details.method },
    link: '/transactions',
  });
}

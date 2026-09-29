import { childLogger } from '../config/logger';
import { SETTING_KEYS } from '../config/constants';
import { getBoolSetting, getSetting } from '../services/settings.service';
import { escapeHtml } from './format';

/**
 * Provider-agnostic mailer.
 *
 * Design rules:
 *   - OFF by default. When `email_enabled` is false the mailer is a logged
 *     no-op — a deployment with no mail credentials must behave exactly like
 *     a deployment with mail, minus the mail.
 *   - A missing transport, a provider outage or a database failure while
 *     reading settings must NEVER throw: `sendMail` always resolves with
 *     `{ sent, reason? }` and the caller decides (usually: nothing).
 *   - `nodemailer` is an OPTIONAL runtime dependency. It is loaded through a
 *     dynamic import with a non-literal specifier so TypeScript does not try
 *     to resolve its module at compile time on machines where it is not
 *     installed — the code degrades to "no transport available" instead.
 */

const log = childLogger('mailer');

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. When omitted the provider uses the HTML only. */
  text?: string;
  /** Override the sender (defaults to the `email_from` setting). */
  from?: string;
  /** Override the reply-to (defaults to the `email_reply_to` setting). */
  replyTo?: string;
}

export interface SendMailResult {
  sent: boolean;
  reason?: string;
}

/** Minimal structural type for a nodemailer-like transport — the only surface sendMail needs. */
interface MailTransport {
  sendMail(message: {
    from?: string;
    to: string;
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string;
  }): Promise<unknown>;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}

/**
 * SMTP configuration from the environment. `SMTP_URL` (e.g.
 * `smtps://user:pass@host:465`) takes precedence over the individual
 * `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` parts.
 * Returns `null` when nothing usable is configured.
 */
function readSmtpConfig(): SmtpConfig | null {
  const e = process.env;

  if (e.SMTP_URL) {
    try {
      const u = new URL(e.SMTP_URL);
      if (!u.hostname) return null;
      return {
        host: u.hostname,
        port: Number(u.port) || (u.protocol === 'smtps:' ? 465 : 587),
        secure: u.protocol === 'smtps:',
        ...(u.username
          ? { auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } }
          : {}),
      };
    } catch {
      log.warn('SMTP_URL is set but is not a valid URL; ignoring it');
      return null;
    }
  }

  if (e.SMTP_HOST) {
    const port = e.SMTP_PORT ? Number(e.SMTP_PORT) : 587;
    return {
      host: e.SMTP_HOST,
      port: Number.isFinite(port) && port > 0 ? port : 587,
      secure: port === 465 || e.SMTP_SECURE === 'true',
      ...(e.SMTP_USER ? { auth: { user: e.SMTP_USER, pass: e.SMTP_PASS ?? '' } } : {}),
    };
  }

  return null;
}

/** Transport cache: `undefined` = not resolved yet, `null` = unavailable. */
let cachedTransport: MailTransport | null | undefined;

async function getTransport(): Promise<MailTransport | null> {
  if (cachedTransport !== undefined) return cachedTransport;

  const config = readSmtpConfig();
  if (!config) {
    cachedTransport = null;
    return null;
  }

  try {
    // The specifier is deliberately a plain `string` variable, not a literal:
    // `await import('nodemailer')` would make TypeScript require the module to
    // exist at compile time, and it is an optional dependency. With a runtime
    // specifier the import compiles on any machine and simply rejects here
    // when the package is absent — which is the "no transport" case.
    const specifier: string = 'nodemailer';
    const nodemailer = (await import(specifier)) as {
      createTransport(options: SmtpConfig): MailTransport;
    };
    cachedTransport = nodemailer.createTransport(config);
    log.info({ host: config.host, port: config.port }, 'smtp transport ready');
    return cachedTransport;
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'nodemailer is not installed or failed to load; email sending is unavailable',
    );
    cachedTransport = null;
    return null;
  }
}

/**
 * Send one email. NEVER throws — every failure mode resolves to
 * `{ sent: false, reason }` so a mail problem can take down no business
 * operation.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  try {
    const enabled = await getBoolSetting(SETTING_KEYS.EMAIL_ENABLED, false);
    if (!enabled) {
      log.info({ to: input.to, subject: input.subject }, 'email disabled — message not sent');
      return { sent: false, reason: 'email disabled' };
    }

    const transport = await getTransport();
    if (!transport) {
      // The switch is ON but there is no way to send: this is a
      // misconfiguration someone must fix, so it is logged at WARN.
      log.warn(
        { to: input.to, subject: input.subject },
        'EMAIL_ENABLED is true but no mail transport is available — message dropped. Configure SMTP_URL or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS.',
      );
      return { sent: false, reason: 'no transport available' };
    }

    const from =
      input.from ?? (await getSetting<string>(SETTING_KEYS.EMAIL_FROM)) ?? 'BotFlow Ads <no-reply@botflow-ads.local>';
    const replyToSetting = await getSetting<string | null>(SETTING_KEYS.EMAIL_REPLY_TO);
    const replyTo = input.replyTo ?? (replyToSetting || undefined);

    await transport.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
      ...(replyTo ? { replyTo } : {}),
    });

    log.info({ to: input.to, subject: input.subject }, 'email sent');
    return { sent: true };
  } catch (err) {
    log.error({ err, to: input.to, subject: input.subject }, 'email send failed');
    return { sent: false, reason: (err as Error).message || 'send failed' };
  }
}

/**
 * Minimal HTML envelope for a notification-mirroring email. Every value is
 * escaped — titles and bodies carry user-influenced strings (campaign names,
 * device labels) and must never become a stored-XSS vector in an inbox.
 */
export function notificationEmailHtml(title: string, body: string): string {
  return (
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
    'max-width:560px;margin:0 auto;padding:24px 16px;color:#1a1a2e;">' +
    `<p style="font-size:16px;font-weight:600;margin:0 0 12px;">${escapeHtml(title)}</p>` +
    `<p style="font-size:14px;line-height:1.6;margin:0;white-space:pre-wrap;">${escapeHtml(body)}</p>` +
    '<p style="font-size:12px;color:#8a8a9a;margin:24px 0 0;">' +
    'BotFlow Ads — this is an automated message. Do not reply; contact support from the app if you need help.' +
    '</p></div>'
  );
}

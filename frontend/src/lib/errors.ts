/**
 * User-facing error copy.
 *
 * Every error shown in the UI should go through `humanError()` so users never
 * see raw stack traces, bare HTTP status codes or internal error codes.
 * Known API error `code` values map to friendly sentences; anything
 * unexpected falls back to the API's own message, then to a generic line.
 */

const GENERIC =
  'Something went wrong. Please try again, and contact support if it keeps happening.';

/** Friendly sentences for every known API error code. */
const CODE_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: 'You are not signed in. Reopen the app from the Telegram bot to log in again.',
  FORBIDDEN: "You don't have permission to do that. If you think this is a mistake, contact support.",
  NOT_FOUND: 'We could not find that. It may have been removed, or the link is out of date.',
  VALIDATION_ERROR: 'Please check your input and try again — some details are missing or invalid.',
  CONFLICT: 'This conflicts with a more recent change. Refresh the page and try again.',
  RATE_LIMITED: "You're going a bit fast — wait a few seconds and try again.",
  INSUFFICIENT_BALANCE: 'Your balance is too low for this action. Top up your wallet first.',
  INVALID_TELEGRAM_AUTH: 'We could not verify your Telegram session. Reopen the app from the Telegram bot.',
  BOT_PERMISSION_MISSING:
    'The bot is missing a permission in your channel. Re-add it as an admin with the required rights.',
  CHANNEL_NOT_ELIGIBLE:
    'This channel is not eligible for ads yet — it may still be in review or below the minimums.',
  MAINTENANCE: 'We are doing scheduled maintenance. Please try again in a few minutes.',
  SCHEMA_OUT_OF_DATE:
    'The app is being updated right now. Please try again in a minute — nothing you did caused this.',
  PAYMENT_DUPLICATE: 'This payment was already applied to your account — no double charge was made.',
};

/**
 * Raw HTTP statuses that sometimes arrive without an API `code`
 * (e.g. a 404 from an endpoint the backend has not deployed yet).
 */
const STATUS_MESSAGES: Record<number, string> = {
  400: CODE_MESSAGES.VALIDATION_ERROR,
  401: CODE_MESSAGES.UNAUTHORIZED,
  403: CODE_MESSAGES.FORBIDDEN,
  404: CODE_MESSAGES.NOT_FOUND,
  409: CODE_MESSAGES.CONFLICT,
  422: CODE_MESSAGES.VALIDATION_ERROR,
  429: CODE_MESSAGES.RATE_LIMITED,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** True when the text must never reach the user (stack, bare status, axios plumbing). */
function isUnsafeMessage(message: string): boolean {
  const t = message.trim();
  if (t.length > 300) return true; // stack traces / raw payloads
  if (/^\d{3}$/.test(t)) return true; // bare status code, e.g. "404"
  if (/^request failed with status code \d{3}\.?$/i.test(t)) return true; // axios default text
  if (/\n\s*at\s[\w$.[\]]+\([^)]*\)/.test(t)) return true; // stack frame
  if (/^[A-Za-z]+Error\b/.test(t) && t.includes('\n')) return true; // multi-line error dump
  return false;
}

function safeMessage(err: unknown): string | null {
  if (typeof err === 'string') {
    return isUnsafeMessage(err) ? null : err.trim() || null;
  }
  if (isPlainObject(err) && typeof err.message === 'string' && !isUnsafeMessage(err.message)) {
    const t = err.message.trim();
    if (t) return t;
  }
  return null;
}

/**
 * Friendly sentence for a known API error code. Unknown codes return the
 * generic line — never the code itself.
 */
export function humanErrorFor(code: string): string {
  const key = (code ?? '').trim().toUpperCase();
  return CODE_MESSAGES[key] ?? GENERIC;
}

/**
 * Human-readable message for any thrown value (safe for toasts and error
 * states). Preference: known API code → known HTTP status → API message →
 * generic line. Never returns a raw stack trace or a bare status code.
 */
export function humanError(err: unknown): string {
  if (isPlainObject(err)) {
    const { code, status } = err;
    if (typeof code === 'string') {
      const key = code.trim().toUpperCase();
      if (key && key !== 'HTTP_ERROR' && key !== 'NETWORK_ERROR' && CODE_MESSAGES[key]) {
        return CODE_MESSAGES[key];
      }
    }
    const numStatus = typeof status === 'number' ? status : Number(status);
    if (Number.isInteger(numStatus) && STATUS_MESSAGES[numStatus]) {
      return STATUS_MESSAGES[numStatus];
    }
  }
  return safeMessage(err) ?? GENERIC;
}

/** True when the error means "does not exist" (API code NOT_FOUND or HTTP 404). */
export function isNotFoundError(err: unknown): boolean {
  if (!isPlainObject(err)) return false;
  if (err.code === 'NOT_FOUND') return true;
  return err.status === 404 || err.status === '404';
}

/**
 * True when an error means "you hit a plan limit — upgrade to go further".
 *
 * The gate is enforced server-side and different gates may use different codes,
 * so detection matches the code *and* the text the API sent. The one thing it
 * must never do is miss a real limit error: swallowing the server's sentence is
 * exactly how a user ends up stuck with no explanation.
 */
function isLimitCode(code: string): boolean {
  if (!code) return false;
  // Throttling is a "wait", not a "pay" — never an upgrade prompt.
  if (code === 'RATE_LIMITED' || code === 'LIMITED') return false;
  return /(QUOTA|PREMIUM|UPGRADE|SUBSCRIPTION|TIER)/.test(code) || /(^|_)LIMIT(_|$)/.test(code);
}

const LIMIT_TEXT_RE =
  /(upgrade to premium|premium to|plan limit|reached your [a-z ]*limit|quota|higher tier|not included in your plan)/i;

export function isLimitError(err: unknown): boolean {
  if (!isPlainObject(err)) return false;
  const code = typeof err.code === 'string' ? err.code.trim().toUpperCase() : '';
  if (isLimitCode(code)) return true;
  if (Number(err.status) === 402) return true;
  return typeof err.message === 'string' && LIMIT_TEXT_RE.test(err.message);
}

/**
 * Message to show for a limit error. The API names the exact limit that was hit
 * ("Free accounts can run 2 active campaigns…"), so that sentence wins; the
 * friendly code mapping is only the fallback.
 */
export function limitMessage(err: unknown): string {
  if (isLimitError(err)) return safeMessage(err) ?? humanError(err);
  return humanError(err);
}

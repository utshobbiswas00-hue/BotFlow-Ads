/**
 * Client side of the staff panel's cookie session.
 *
 * What changed from the first cut: the credential is no longer a token held in
 * JS. The session is an HttpOnly cookie the browser attaches by itself, and the
 * only thing this module keeps is the CSRF value the server wants echoed back in
 * `x-csrf-token`.
 *
 * That split is the point of the design:
 *  - the session id is HttpOnly, so XSS on this origin cannot read it — a
 *    material improvement over a token in localStorage, which any injected script
 *    could exfiltrate;
 *  - the CSRF value is deliberately NOT secret. Its job is to prove the request
 *    came from our own code rather than a cross-site form, so it must be readable
 *    by that code. Leaking it is not a compromise.
 *
 * `sessionStorage` rather than `localStorage`: the CSRF value is only needed to
 * survive a reload in the tab that signed in, and the server hands out a fresh
 * one on every `GET /api/admin/auth/me`, so there is no reason to persist it
 * beyond the tab.
 */

/** Must match `ADMIN_PANEL_CSRF_COOKIE` on the server (its default). */
const CSRF_COOKIE = 'bf_admin_csrf';
const CSRF_STORE = 'botflow.admin.csrf';

function cookieValue(name: string): string | null {
  if (typeof document === 'undefined') return null;

  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;

    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** The value the server seeded for this browser (non-HttpOnly by design). */
export function readCsrfCookie(): string | null {
  return cookieValue(CSRF_COOKIE);
}

export function setCsrfToken(value: string | null): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    if (value) sessionStorage.setItem(CSRF_STORE, value);
    else sessionStorage.removeItem(CSRF_STORE);
  } catch {
    /* storage unavailable — the header simply will not be set */
  }
}

/**
 * The value to send as `x-csrf-token`.
 *
 * In-memory copy first (the freshest, rotated at login), then the cookie. After a
 * reload `GET /auth/me` re-supplies it, so a missing copy is self-healing rather
 * than a dead end.
 */
export function getCsrfHeader(): string | null {
  if (typeof sessionStorage !== 'undefined') {
    try {
      const stored = sessionStorage.getItem(CSRF_STORE);
      if (stored) return stored;
    } catch {
      /* fall through to the cookie */
    }
  }
  return readCsrfCookie();
}

export function clearAdminSession(): void {
  setCsrfToken(null);
}

/**
 * Which requests may carry the session cookie and the CSRF header.
 *
 * Restricting this keeps Mini App traffic clean: `/api/admin/*` plus the
 * admin-gated `/health/queues` probe. The cookie itself would be attached by the
 * browser regardless (it is scoped to the path), but not sending a CSRF value on
 * unrelated endpoints keeps the intent obvious.
 */
export function isAdminScopedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith('/api/admin/') || url.startsWith('/health');
}

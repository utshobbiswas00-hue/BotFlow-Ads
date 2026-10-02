import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { identityFromAdminId } from '../services/adminPanelAuth.service';
import { csrfMatches, readSession } from '../services/adminSession.service';
import { appendSetCookie, clearCookie, readCookie } from '../utils/cookies';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { telegramAuth } from './telegramAuth';

/**
 * The one auth gate for everything under `/api/admin`.
 *
 * Two doors:
 *
 *  1. **Session cookie** — `bf_admin_sid`, set by `POST /api/admin/auth/login`
 *     after a username + password check. The cookie holds a 256-bit random id;
 *     the actual session (admin id, CSRF secret, ip, user agent) lives in Redis
 *     under `sha256(id)`, so a leaked store cannot be replayed. Because this door
 *     is a cookie, it is the one that needs CSRF protection — see below.
 *
 *  2. **Telegram initData** — unchanged. Header-carried, so it is structurally
 *     immune to CSRF: a cross-site form post cannot set a header. Every existing
 *     admin caller (the Mini App) keeps working, and a broken password login
 *     cannot lock an operator out.
 *
 * Both converge on the same `req.user`, so `requireAdmin`, `requireRole` and
 * `requirePermission` downstream cannot tell which door was used.
 *
 * ---------------------------------------------------------------------------
 * CSRF
 * ---------------------------------------------------------------------------
 * Enforced ONLY for the cookie door, and only for unsafe methods. That is not a
 * shortcut — it is the correct scope. CSRF is an attack on credentials the
 * browser attaches automatically; a header credential has no such property, so
 * demanding a CSRF token from the Telegram path would add a failure mode without
 * adding protection.
 *
 * The check compares the `x-csrf-token` header against the secret stored IN THE
 * SESSION, not against the other cookie. Plain double-submit (cookie vs header)
 * is defeated by anyone who can write a cookie on the victim's registrable
 * domain — a subdomain takeover, or a sibling app on the same domain. With the
 * expected value held server-side, only the token minted at login is accepted.
 */
export function adminPanelAuth() {
  const viaTelegram = telegramAuth();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const sid = readCookie(req.headers.cookie, env.ADMIN_PANEL_SESSION_COOKIE);

    if (!sid) {
      // No panel cookie: this is the Mini App (or a bare browser). Hand off
      // without touching the request further.
      return viaTelegram(req, res, next);
    }

    try {
      const session = await readSession(sid);

      if (!session) {
        // The cookie is present but unknown or expired. Clear it so the browser
        // stops sending a value that can only ever fail, and answer 401 so the
        // client shows the sign-in screen rather than a generic error.
        appendSetCookie(res, clearPanelSessionCookie());
        next(new UnauthorizedError('Your panel session has expired — please sign in again'));
        return;
      }

      if (isUnsafeMethod(req.method) && !csrfMatches(session.csrf, req.header('x-csrf-token') ?? '')) {
        next(
          new ForbiddenError(
            'Missing or invalid CSRF token. Reload the panel — a stale tab signs in again automatically.',
          ),
        );
        return;
      }

      // Re-read the admin row: an admin deactivated a moment ago is out now, even
      // though their session record is still valid and unexpired.
      const identity = await identityFromAdminId(session.adminId);

      req.user = {
        id: identity.adminUserId,
        telegramId: identity.telegramId,
        username: null,
        status: 'ACTIVE',
        isAdvertiser: false,
        isPublisher: false,
      };

      // `requireAdmin` runs next and re-reads the row by `userId`, overwriting
      // this. Set anyway so a route wired without `requireAdmin` still carries a
      // complete identity.
      req.admin = {
        id: identity.adminId,
        role: identity.role,
        permissions: identity.permissions,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Methods that change state. GET/HEAD/OPTIONS are excluded — they must be safe. */
function isUnsafeMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/** The empty cookie used to retire an expired session id in the browser. */
export function clearPanelSessionCookie(): string {
  return clearCookie(env.ADMIN_PANEL_SESSION_COOKIE, {
    path: '/',
    secure: env.ADMIN_PANEL_COOKIE_SECURE,
    sameSite: 'Strict',
  });
}

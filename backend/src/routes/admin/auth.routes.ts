import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { requireAdmin } from '../../middleware/adminAuth';
import { adminPanelAuth, clearPanelSessionCookie } from '../../middleware/adminPanelAuth';
import { limiters } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { isPanelLoginEnabled, loginWithPassword } from '../../services/adminPanelAuth.service';
import {
  createSession,
  csrfMatches,
  destroyAllSessions,
  destroySession,
  listSessions,
  readSession,
} from '../../services/adminSession.service';
import { trackSession } from '../../services/alert.service';
import { appendSetCookie, clearCookie, readCookie, serializeCookie } from '../../utils/cookies';
import { ForbiddenError } from '../../utils/errors';
import { respondOk } from './common';

/**
 * Staff panel authentication.
 *
 * Split into two routers on purpose:
 *
 *  - `adminAuthPublicRouter` — `config` and `login`. Mounted BEFORE the router
 *    level auth gate, because they are the way in.
 *  - `adminAuthRouter` — `me`, `logout`, `sessions`. Mounted AFTER the gate, so
 *    they can assume a resolved identity.
 *
 * ## Why the login itself needs CSRF
 *
 * A state-changing POST with no session is still attackable: "login CSRF", where
 * an attacker silently signs the victim into the ATTACKER's account and the
 * victim then does work (or enters data) inside it. The fix is a token that
 * exists before the session does. `GET /config` seeds a non-HttpOnly
 * `bf_admin_csrf` cookie; `POST /login` requires that value in the
 * `x-csrf-token` header. Double-submit is sufficient here precisely because
 * there is no session yet to hold a better secret — and the token is rotated the
 * moment one exists, so a value fixed by an attacker cannot survive into the
 * authenticated session.
 */
export const adminAuthPublicRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
});

/** 12 hours, matching the session TTL. */
function cookieMaxAge(): number {
  return Math.max(60, env.ADMIN_PANEL_SESSION_TTL_HOURS * 3600);
}

function panelCookieBase() {
  return {
    maxAge: cookieMaxAge(),
    httpOnly: true,
    secure: env.ADMIN_PANEL_COOKIE_SECURE,
    sameSite: 'Strict' as const,
    path: '/',
  };
}

/**
 * Write the session cookie plus the CSRF cookie the client must echo.
 * The CSRF cookie is intentionally readable by JS — that is the mechanism.
 */
function setPanelCookies(res: Parameters<typeof appendSetCookie>[0], sid: string, csrf: string): void {
  appendSetCookie(
    res,
    serializeCookie(env.ADMIN_PANEL_SESSION_COOKIE, sid, panelCookieBase()),
  );
  appendSetCookie(
    res,
    serializeCookie(env.ADMIN_PANEL_CSRF_COOKIE, csrf, {
      ...panelCookieBase(),
      httpOnly: false,
    }),
  );
}

function clearPanelCookies(res: Parameters<typeof appendSetCookie>[0]): void {
  appendSetCookie(res, clearPanelSessionCookie());
  appendSetCookie(
    res,
    clearCookie(env.ADMIN_PANEL_CSRF_COOKIE, {
      path: '/',
      secure: env.ADMIN_PANEL_COOKIE_SECURE,
      sameSite: 'Strict',
    }),
  );
}

/**
 * Tells the login screen whether a password is configured at all, and seeds the
 * pre-session CSRF cookie. No secret is involved: "a panel login exists" is
 * observable from whether the form works, and hiding it would only waste the
 * operator's first attempt.
 */
adminAuthPublicRouter.get('/config', (_req, res, next) => {
  try {
    // Keep an existing value if the browser already has one, so a login form that
    // was left open in another tab is not invalidated by a reload here.
    const existing = readCookie(_req.headers.cookie, env.ADMIN_PANEL_CSRF_COOKIE);
    if (!existing) {
      appendSetCookie(
        res,
        serializeCookie(env.ADMIN_PANEL_CSRF_COOKIE, crypto.randomBytes(32).toString('base64url'), {
          ...panelCookieBase(),
          httpOnly: false,
        }),
      );
    }
    respondOk(res, { passwordLoginEnabled: isPanelLoginEnabled() });
  } catch (err) {
    next(err);
  }
});

adminAuthPublicRouter.post(
  '/login',
  limiters.adminLogin,
  validate({ body: loginSchema }),
  async (req, res, next) => {
    try {
      // Pre-session CSRF: the header must match the cookie the server issued.
      const csrfCookie = readCookie(req.headers.cookie, env.ADMIN_PANEL_CSRF_COOKIE);
      const csrfHeader = req.header('x-csrf-token') ?? '';
      if (!csrfCookie || !csrfMatches(csrfCookie, csrfHeader)) {
        throw new ForbiddenError(
          'Missing or invalid CSRF token. Reload the page and sign in again.',
        );
      }

      const { username, password } = req.body as z.infer<typeof loginSchema>;
      const identity = await loginWithPassword(username, password);

      const session = await createSession({
        adminId: identity.adminId,
        ip: req.ip ?? 'unknown',
        userAgent: req.header('user-agent') ?? 'unknown',
      });

      // Rotate the CSRF value now that a session exists: the pre-session value was
      // writable by whatever set it, the new one lives in the session record.
      setPanelCookies(res, session.sid, session.csrf);

      // Reuse the existing device/IP sign-in tracking, so a panel login appears in
      // the same trail as a Telegram one and can raise a new-device alert.
      trackSession(identity.adminUserId, req);

      logger.info(
        { adminId: identity.adminId, role: identity.role, ip: req.ip },
        'admin panel: password login succeeded',
      );

      respondOk(res, {
        csrf: session.csrf,
        expiresAt: session.expiresAt,
        admin: {
          id: identity.adminId,
          role: identity.role,
          isActive: true,
          isSuperAdmin: identity.role === 'SUPER_ADMIN',
          permissions: identity.permissions,
          lastLoginAt: new Date().toISOString(),
        },
        user: {
          id: identity.adminUserId,
          telegramId: identity.telegramId,
          name: identity.name,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------------------------
 *  Authenticated
 * ------------------------------------------------------------------ */

export const adminAuthRouter = Router();

adminAuthRouter.use(adminPanelAuth(), requireAdmin());

/**
 * The acting identity plus the current CSRF token.
 *
 * Returning the CSRF value matters: after a page reload the client has the
 * cookie but has lost the in-memory copy, and re-reading the readable cookie is
 * enough here because the server still verifies against the session record. This
 * is also what revalidates the session cookie on a cold load.
 */
adminAuthRouter.get('/me', async (req, res, next) => {
  try {
    const admin = req.admin;
    if (!admin) throw new ForbiddenError('Admin access required');

    const sid = readCookie(req.headers.cookie, env.ADMIN_PANEL_SESSION_COOKIE);
    const session = sid ? await readSession(sid) : null;

    respondOk(res, {
      admin: {
        id: admin.id,
        role: admin.role,
        isSuperAdmin: admin.role === 'SUPER_ADMIN',
        permissions: admin.permissions,
      },
      csrf: session?.csrf ?? null,
      // Null when the caller authenticated with Telegram rather than the cookie —
      // the client uses that to decide whether to show a "sign out" control.
      sessionActive: session !== null,
    });
  } catch (err) {
    next(err);
  }
});

adminAuthRouter.post('/logout', async (req, res, next) => {
  try {
    const sid = readCookie(req.headers.cookie, env.ADMIN_PANEL_SESSION_COOKIE);
    if (sid) await destroySession(sid);
    clearPanelCookies(res);
    respondOk(res, { loggedOut: true });
  } catch (err) {
    next(err);
  }
});

/** Live sessions for the acting admin — the reason a real store is worth having. */
adminAuthRouter.get('/sessions', async (req, res, next) => {
  try {
    const admin = req.admin;
    if (!admin) throw new ForbiddenError('Admin access required');
    respondOk(res, { sessions: await listSessions(admin.id) });
  } catch (err) {
    next(err);
  }
});

/** Sign out everywhere, including this browser. */
adminAuthRouter.post('/sessions/revoke-all', async (req, res, next) => {
  try {
    const admin = req.admin;
    if (!admin) throw new ForbiddenError('Admin access required');
    const revoked = await destroyAllSessions(admin.id);
    clearPanelCookies(res);
    logger.info({ adminId: admin.id, revoked }, 'admin panel: all sessions revoked');
    respondOk(res, { revoked });
  } catch (err) {
    next(err);
  }
});

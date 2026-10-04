import { Router } from 'express';
import type { Request } from 'express';
import { logger } from '../config/logger';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';

/* ===================================================================
 *  /api/auth — public session helpers
 *
 *  The whole app reads identity through `telegramAuth` middleware; this
 *  router exposes the small set of endpoints that don't fit anywhere else.
 *
 *    POST /api/auth/logout   end the user's session — clears any httpOnly
 *                            cookie set at login. Telegram's WebApp
 *                            initData is re-validated on every request, so
 *                            the session ends immediately.
 * ================================================================== */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

export const authRouter = Router();

authRouter.post('/logout', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.clearCookie('bf_session', { path: '/' });
    logger.info({ userId: user.id }, 'user signed out');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
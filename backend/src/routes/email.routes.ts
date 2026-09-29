import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { setEmailSchema } from '@botflow/shared';
import { validate } from '../middleware/validate';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import { getEmailState, setUserEmail, verifyEmailToken } from '../services/email.service';

/**
 * Account email routes. Everything sits behind `telegramAuth` (applied once
 * at the /api router level, see routes/index.ts).
 *
 * Verification flow: the emailed link opens the Mini App with a `token`
 * start-param; the app posts that token here, and ONLY the account the token
 * was issued to can complete the verification.
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError('Open the app from Telegram to continue.');
  return req.user;
}

export const emailRouter = Router();

/** GET /api/me/email — current address and verification state. */
emailRouter.get('/me/email', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await getEmailState(user.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/email — set or change the address. Clears the verified state
 * and queues a verification link. Posting the current address again doubles
 * as "resend verification".
 */
emailRouter.post(
  '/me/email',
  validate({ body: setEmailSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { email } = req.body as { email: string };
      res.json({ ok: true, data: await setUserEmail(user.id, email) });
    } catch (err) {
      next(err);
    }
  },
);

/** POST /api/me/email/verify — complete verification with the emailed token. */
emailRouter.post(
  '/me/email/verify',
  validate({ body: z.object({ token: z.string().min(8).max(128) }) }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { token } = req.body as { token: string };
      const result = await verifyEmailToken(token);

      // The token is the proof the address is the recipient's, but the
      // endpoint still requires the token's own account: a valid link leaked
      // to someone else must not be able to touch a different user's row.
      if (result.userId !== user.id) {
        throw new ForbiddenError('This verification link belongs to a different account.');
      }

      res.json({ ok: true, data: { verified: true, email: result.email } });
    } catch (err) {
      next(err);
    }
  },
);

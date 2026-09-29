import { Router } from 'express';
import type { Request } from 'express';
import { env } from '../config/env';
import { getPagination } from '../utils/pagination';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import { getReferralSummary } from '../services/referral.service';

/**
 * Referral program routes. All sit behind `telegramAuth`
 * (applied once at the /api router level, see routes/index.ts).
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

export const referralRouter = Router();

/** GET /api/referrals — code, stats, recent referrals and the share link. */
referralRouter.get('/referrals', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const summary = await getReferralSummary(user.id, getPagination(req.query));
    // Telegram opens `t.me/<bot>?start=ref_<code>` into the Mini App;
    // telegramAuth maps the start_param back onto the referrer at signup.
    const shareLink = `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=ref_${summary.referralCode}`;
    res.json({ ok: true, data: { ...summary, shareLink } });
  } catch (err) {
    next(err);
  }
});

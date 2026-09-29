import { Router } from 'express';
import type { Request } from 'express';
import { createReportSchema } from '@botflow/shared';
import { validate } from '../middleware/validate';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import { createReport } from '../services/report.service';

/**
 * Ad-post reporting (scam / spam / broken link / ...). Sits behind
 * `telegramAuth` (applied once at the /api router level, see routes/index.ts).
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

export const reportRouter = Router();

/** POST /api/reports — file a report against a live ad post. */
reportRouter.post('/reports', validate({ body: createReportSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await createReport(user.id, req.body) });
  } catch (err) {
    next(err);
  }
});

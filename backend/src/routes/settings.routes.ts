import { Router } from 'express';
import { getPublicSettings } from '../services/settings.service';

/**
 * Public, non-sensitive settings (fee percent, allowed methods, ...).
 * Only rows flagged `isPublic` in the settings table are ever returned —
 * admin values are managed exclusively under /api/admin.
 */

export const settingsRouter = Router();

/** GET /api/settings/public */
settingsRouter.get('/settings/public', async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await getPublicSettings() });
  } catch (err) {
    next(err);
  }
});

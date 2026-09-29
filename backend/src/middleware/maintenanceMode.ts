import type { NextFunction, Request, Response } from 'express';
import { ERROR_CODES } from '../config/constants';
import { businessRules } from '../services/settings.service';

/**
 * Global maintenance switch (admin toggleable, stored in `settings`).
 *
 * Paths that must keep working while maintenance mode is ON:
 *   - /health      → uptime probes
 *   - /webhook     → payment webhooks (a payment must never be lost)
 *   - /c/          → public click-tracking redirects, so live ads keep
 *                     tracking even while the Mini App is closed
 *   - /api/admin   → the admin panel itself (to turn maintenance off)
 */
const SKIPPED_PATH_PREFIXES = ['/health', '/webhook', '/c/', '/api/admin'];

export function maintenanceGuard() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const path = req.path;
    if (SKIPPED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      return next();
    }

    try {
      if (!(await businessRules.maintenanceMode())) {
        return next();
      }

      const message = await businessRules.maintenanceMessage();
      res.status(503).json({
        ok: false,
        error: { code: ERROR_CODES.MAINTENANCE, message },
      });
    } catch (err) {
      next(err);
    }
  };
}

import { Router } from 'express';
import { paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { getPagination } from '../../utils/pagination';
import { listErrorLogs } from '../../services/errorLog.service';
import { respondOk } from './common';

/**
 * Persisted server errors (spec §84).
 *
 * Read side of `error_logs`. The writes happen in the central error handler via
 * `errorLog.service.recordError()`; this route only lists them, newest first, with
 * an optional source / level / `from`–`to` filter. Mounted by the caller at
 * `/api/admin/errors` — this file is intentionally NOT wired into index.ts.
 */
export const errorsRouter = Router();

const errorsQuery = paginationSchema.extend({
  source: z.string().min(1).optional(),
  level: z.string().min(1).optional(),
  // Matches the delivery/audit query convention: `from` inclusive, `to` exclusive.
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

type ErrorsQuery = z.infer<typeof errorsQuery>;

errorsRouter.get(
  '/',
  requirePermission('audit.view'),
  validate({ query: errorsQuery }),
  async (req, res, next) => {
    try {
      const query = req.query as unknown as ErrorsQuery;
      const data = await listErrorLogs(
        { source: query.source, level: query.level, from: query.from, to: query.to },
        getPagination(query),
      );
      respondOk(res, data);
    } catch (err) {
      next(err);
    }
  },
);

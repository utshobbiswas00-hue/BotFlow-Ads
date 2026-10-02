import { Router } from 'express';
import { DeliveryJobStatus } from '@prisma/client';
import { paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { DELIVERY_SORT_KEYS, listDeliveryJobs } from '../../services/admin.service';
import { deliveryQueueStats, retryDeliveryJob } from '../../services/delivery.service';
import { requirePermission } from '../../middleware/adminAuth';
import { AppError } from '../../utils/errors';
import { idParams, respondOk } from './common';
import { getPagination } from '../../utils/pagination';

export const deliveryRouter = Router();

/**
 * Optional date window (§79). `z.coerce.date()` matches the audit-log query in
 * settings.routes.ts. `from` is inclusive, `to` is exclusive.
 */
const dateRangeQuery = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

/** A backwards window (`from > to`) is a client mistake → 400. */
function assertDateRange(q: { from?: Date; to?: Date }): void {
  if (q.from && q.to && q.from > q.to) {
    throw new AppError('`from` must be earlier than or equal to `to`', 400);
  }
}

const deliveryQuery = paginationSchema.extend({
  status: z.nativeEnum(DeliveryJobStatus).optional(),
  ...dateRangeQuery,
  // Whitelisted sort keys; `listDeliveryJobs` maps each key to an explicit Prisma
  // orderBy, so a client string never reaches the query builder (§79).
  sort: z.enum(DELIVERY_SORT_KEYS).optional(),
});

type DeliveryQuery = z.infer<typeof deliveryQuery>;

/**
 * All delivery jobs, most recently scheduled first by default, optionally by
 * status and a `from`/`to` window on `scheduledAt` (§79). `sort` reorders within
 * the whitelist.
 */
deliveryRouter.get('/', requirePermission('delivery.view'), validate({ query: deliveryQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as DeliveryQuery;
    assertDateRange(query);
    const data = await listDeliveryJobs(
      { status: query.status, from: query.from, to: query.to, sort: query.sort },
      getPagination(query),
    );
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** Queue health: published / pending / failed / awaiting approval counts. */
deliveryRouter.get('/stats', requirePermission('delivery.view'), async (_req, res, next) => {
  try {
    const data = await deliveryQueueStats();
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** Reset a failed/stuck job to PENDING and re-enqueue it for publishing. */
deliveryRouter.post('/:id/retry', requirePermission('delivery.manage'), validate({ params: idParams }), async (req, res, next) => {
  try {
    await retryDeliveryJob(req.params.id);
    respondOk(res, { id: req.params.id, retried: true });
  } catch (err) {
    next(err);
  }
});

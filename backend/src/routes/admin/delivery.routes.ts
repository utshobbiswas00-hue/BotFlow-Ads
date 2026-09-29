import { Router } from 'express';
import { DeliveryJobStatus } from '@prisma/client';
import { paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { listDeliveryJobs } from '../../services/admin.service';
import { deliveryQueueStats, retryDeliveryJob } from '../../services/delivery.service';
import { requirePermission } from '../../middleware/adminAuth';
import { idParams, respondOk } from './common';
import { getPagination } from '../../utils/pagination';

export const deliveryRouter = Router();

const deliveryQuery = paginationSchema.extend({
  status: z.nativeEnum(DeliveryJobStatus).optional(),
});

type DeliveryQuery = z.infer<typeof deliveryQuery>;

/** All delivery jobs, most recently scheduled first, optionally by status. */
deliveryRouter.get('/', requirePermission('delivery.view'), validate({ query: deliveryQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as DeliveryQuery;
    const data = await listDeliveryJobs({ status: query.status }, getPagination(query));
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

import { Router } from 'express';
import { adminDashboard } from '../../services/admin.service';
import { deliveryQueueStats } from '../../services/delivery.service';
import { requirePermission } from '../../middleware/adminAuth';
import { respondOk } from './common';

export const dashboardRouter = Router();

dashboardRouter.use(requirePermission('dashboard.view'));

/** KPI tiles for the admin dashboard. */
dashboardRouter.get('/', async (_req, res, next) => {
  try {
    const data = await adminDashboard();
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** Delivery queue health: published / pending / failed / awaiting approval. */
dashboardRouter.get('/queues', async (_req, res, next) => {
  try {
    const data = await deliveryQueueStats();
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

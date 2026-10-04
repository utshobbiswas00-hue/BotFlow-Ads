import { Router } from 'express';
import { ReportStatus } from '@prisma/client';
import { paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { moderateAdPost } from '../../services/moderation.service';
import { recalculateUserRisk, scanClickPatterns } from '../../services/fraud.service';
import { listReports, resolveReport } from '../../services/report.service';
import { requirePermission } from '../../middleware/adminAuth';
import { adminId, idParams, respondOk } from './common';
import { getPagination } from '../../utils/pagination';

export const moderationRouter = Router();

const reportsQuery = paginationSchema.extend({
  status: z.nativeEnum(ReportStatus).optional(),
});

const reportActionSchema = z.object({
  reportId: z.string().min(1),
  action: z.enum(['RESOLVE', 'DISMISS']),
  actionTaken: z.string().max(500).optional().nullable(),
});

const adPostActionSchema = z.object({
  adPostId: z.string().min(1),
  action: z.enum(['REMOVE', 'APPROVE']),
});

/** All user reports, newest first, optionally filtered by status. */
moderationRouter.get('/reports', requirePermission('fraud.view'), validate({ query: reportsQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as z.infer<typeof reportsQuery>;
    const data = await listReports({ status: query.status }, getPagination(query));
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** Close out a report: RESOLVE (issue acted on) or DISMISS (no action). */
moderationRouter.post('/reports/action', requirePermission('fraud.manage'), validate({ body: reportActionSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof reportActionSchema>;
    const data = await resolveReport(adminId(req), body.reportId, body.action, body.actionTaken ?? undefined);
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** REMOVE takes a live post down on Telegram + marks it DELETED; APPROVE releases a held post back to the queue. */
moderationRouter.post('/ads/action', requirePermission('fraud.manage'), validate({ body: adPostActionSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof adPostActionSchema>;
    const data = await moderateAdPost(adminId(req), body.adPostId, body.action);
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** Run the click-pattern fraud scan now; returns the number of new events. */
moderationRouter.post('/scan', requirePermission('fraud.manage'), async (_req, res, next) => {
  try {
    const events = await scanClickPatterns();
    respondOk(res, { events });
  } catch (err) {
    next(err);
  }
});

/** Recompute a user's risk score from their unresolved fraud events. */
moderationRouter.post('/users/:id/risk', requirePermission('fraud.manage'), validate({ params: idParams }), async (req, res, next) => {
  try {
    const score = await recalculateUserRisk(req.params.id);
    respondOk(res, { score });
  } catch (err) {
    next(err);
  }
});

import { Router } from 'express';
import { updateSettingSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { listAuditLogs } from '../../services/audit.service';
import { getAllSettings, setSetting } from '../../services/settings.service';
import { requirePermission } from '../../middleware/adminAuth';
import { adminId, respondOk } from './common';

export const settingsRouter = Router();

const auditLogsQuery = z.object({
  actorId: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  targetType: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  skip: z.coerce.number().int().min(0).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
});

type AuditLogsQuery = z.infer<typeof auditLogsQuery>;

/** All settings (DB rows merged over code defaults), cached for 60s. */
settingsRouter.get('/', requirePermission('settings.manage'), async (_req, res, next) => {
  try {
    const data = await getAllSettings();
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** Upsert a single setting; the admin is recorded as updatedById. */
settingsRouter.post('/', requirePermission('settings.manage'), validate({ body: updateSettingSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof updateSettingSchema>;
    await setSetting(body.key, body.value, adminId(req));
    respondOk(res, { updated: true });
  } catch (err) {
    next(err);
  }
});

/** Append-only audit trail of admin actions, newest first. */
settingsRouter.get('/audit-logs', requirePermission('audit.view'), validate({ query: auditLogsQuery }), async (req, res, next) => {
  try {
    const q = req.query as unknown as AuditLogsQuery;
    const data = await listAuditLogs({
      actorId: q.actorId,
      action: q.action,
      targetType: q.targetType,
      from: q.from,
      to: q.to,
      skip: q.skip,
      take: q.take,
    });
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

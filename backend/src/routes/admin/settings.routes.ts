import { Router } from 'express';
import { updateSettingSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { listAuditLogs } from '../../services/audit.service';
import { getAllSettings, setSetting } from '../../services/settings.service';
import { requirePermission } from '../../middleware/adminAuth';
import { SETTING_DEFAULTS } from '../../config/constants';
import { AppError } from '../../utils/errors';
import { adminUserId, respondOk } from './common';

export const settingsRouter = Router();

/**
 * `updateSettingSchema` (shared) is deliberately key-agnostic: it can only check
 * that an array value is *a list of primitives*. It cannot know that
 * `budget_alert_thresholds` is a list of NUMBERS while
 * `allowed_withdrawal_methods` is a list of STRINGS. Without this guard a
 * `["50"]` submitted for a numeric threshold passes the shape check, is stored
 * as JSON, and then compares as a string at runtime — silently disabling the
 * alert (50 <= budgetPercent is false for "50").
 *
 * The expectation is derived from the key's OWN default in `SETTING_DEFAULTS`
 * rather than a second hand-maintained table that can drift: if the default is
 * an array, every submitted item must share the primitive type of the default's
 * items, and the value itself must be a list. An empty default (`[]`) carries no
 * element-type information and accepts anything.
 *
 * The "must be a list" half exists because a scalar used to slip through: it was
 * stored as a scalar and then ignored by `getArraySetting`, which fell back to the
 * default — the admin saw "saved" with no effect. Only keys whose default is an
 * array are subject to it.
 *
 * This lives in the route (not in @botflow/shared) because the shared package is
 * imported BY the backend and must not reach into `backend/src/config`.
 *
 * On a mismatch we THROW a 400 AppError instead of calling `ctx.addIssue` so the
 * client gets a status that names the key and the expected item type — an added
 * issue would surface as the generic 422 envelope the validation middleware
 * produces for every other shape failure.
 */
export function expectedArrayItemTypes(def: unknown): string[] {
  if (!Array.isArray(def)) return [];
  return [...new Set(def.map((item) => typeof item))].sort();
}

export const updateSettingRouteSchema = updateSettingSchema.superRefine((body) => {
  const def = SETTING_DEFAULTS[body.key];

  // A key whose default is a list must be set to a list. Without this, a scalar
  // passes, is stored as a scalar, and `getArraySetting` then ignores it and
  // silently falls back to the default — the admin sees "saved" and the setting
  // never takes effect. Only array-typed keys are affected: primitives are
  // untouched by this guard.
  if (Array.isArray(def) && !Array.isArray(body.value)) {
    throw new AppError(
      `Setting "${body.key}" expects a list of ${expectedArrayItemTypes(def).join(' | ') || 'values'}, but received ${typeof body.value}`,
    );
  }

  if (!Array.isArray(def) || !Array.isArray(body.value)) return;

  // Types present in the default; an empty default carries no element-type
  // information, so anything is accepted.
  const expected = expectedArrayItemTypes(def);
  if (expected.length === 0) return;

  const offenders = body.value.filter((item) => !expected.includes(typeof item));
  if (offenders.length === 0) return;

  const got = [...new Set(offenders.map((item) => typeof item))].sort();
  throw new AppError(
    `Setting "${body.key}" expects ${expected.join(' | ')} items, but received ${got.join(' | ')}`,
  );
});

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
settingsRouter.post('/', requirePermission('settings.manage'), validate({ body: updateSettingRouteSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof updateSettingSchema>;
    await setSetting(body.key, body.value, adminUserId(req));
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

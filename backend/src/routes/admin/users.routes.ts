import { Router, type Request } from 'express';
import { UserStatus } from '@prisma/client';
import { paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import {
  USER_SORT_KEYS,
  adjustUserBalance,
  getUserAdminDetail,
  listUsersAdmin,
} from '../../services/admin.service';
import {
  banUser,
  clearUserSuspension,
  setUserSuspension,
  unbanUser,
  type ModerationContext,
} from '../../services/userModeration.service';
import { requirePermission } from '../../middleware/adminAuth';
import { AppError, ForbiddenError } from '../../utils/errors';
import { adminUserId, idParams, respondOk } from './common';
import { getPagination } from '../../utils/pagination';

export const usersRouter = Router();

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

/**
 * A boolean query param.
 *
 * Deliberately NOT `z.coerce.boolean()`: that treats every non-empty string as
 * `true`, so `?isPublisher=false` would filter for publishers — the opposite of
 * what the caller asked for, silently. Only the four spellings a client can
 * reasonably send are accepted, and anything else is a 400.
 */
const booleanQueryParam = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

const usersQuery = paginationSchema.extend({
  search: z.string().max(100).trim().optional(),
  ...dateRangeQuery,
  // Whitelisted sort keys; `listUsersAdmin` maps each key to an explicit Prisma
  // orderBy, so a client string never reaches the query builder (§79).
  sort: z.enum(USER_SORT_KEYS).optional(),
  /**
   * Role filters (§11, §12). The service derives these from the RELATIONSHIPS
   * (channels / campaigns), not from the cached `User.isPublisher` /
   * `User.isAdvertiser` columns, because derived state can drift — and a drifted
   * flag would make this list lie about who is a publisher.
   */
  isPublisher: booleanQueryParam,
  isAdvertiser: booleanQueryParam,
  /** Account status. Validated against the real Prisma enum. */
  status: z.nativeEnum(UserStatus).optional(),
});

type UsersQuery = z.infer<typeof usersQuery>;

const adjustBalanceSchema = z.object({
  userId: z.string().min(1),
  /** Positive credits, negative debits. Integer cents, non-zero. */
  amountCents: z.number().int().refine((v) => v !== 0, { message: 'amountCents must be a non-zero integer' }),
  reason: z
    .string()
    .max(500)
    .trim()
    .refine((v) => v.length > 0, { message: 'A reason is required' }),
});

type AdjustBalanceBody = z.infer<typeof adjustBalanceSchema>;

/** A moderation reason: required, 3..500 characters. */
const moderationReasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'A reason of at least 3 characters is required')
    .max(500, 'The reason must be at most 500 characters'),
});

type ModerationReasonBody = z.infer<typeof moderationReasonSchema>;

/** Suspend / ban take no body at all; accept (and ignore) an empty object. */
const emptyBodySchema = z.object({});

/**
 * The acting admin's USER id — i.e. the row `AuditLog.actor` points at, and the
 * same id a target user is identified by, so the service can compare the two to
 * block self-moderation. (`req.user` is set by telegramAuth / adminPanelAuth and
 * is present on every admin route.)
 */
function actorUserId(req: Request): string {
  const id = req.user?.id;
  if (!id) throw new ForbiddenError('Admin access required');
  return id;
}

/** Role (for the active-admin guard) plus request metadata (for the audit row). */
function moderationContext(req: Request): ModerationContext {
  return {
    actorRole: req.admin?.role,
    ip: req.ctx?.ip ?? req.ip ?? null,
    userAgent: req.ctx?.userAgent ?? req.header('user-agent') ?? null,
  };
}

/**
 * Search users by name / username / telegramId, newest registrations first by
 * default. Optional `from`/`to` window on `createdAt` and a whitelisted `sort`
 * (§79). `search` is unchanged.
 */
usersRouter.get('/', requirePermission('users.view'), validate({ query: usersQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as UsersQuery;
    assertDateRange(query);
    const data = await listUsersAdmin(query.search, getPagination(query), {
      from: query.from,
      to: query.to,
      sort: query.sort,
      status: query.status,
      isPublisher: query.isPublisher,
      isAdvertiser: query.isAdvertiser,
    });
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** Full dossier: profile, channels, campaigns, recent finance, earnings. */
usersRouter.get('/:id', requirePermission('users.view'), validate({ params: idParams }), async (req, res, next) => {
  try {
    const data = await getUserAdminDetail(req.params.id);
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/**
 * Manual credit (positive) or debit (negative) of a user's available
 * balance. Runs through the ledger and is audited.
 */
usersRouter.post('/adjust-balance', requirePermission('users.balance.adjust'), validate({ body: adjustBalanceSchema }), async (req, res, next) => {
  try {
    const body = req.body as AdjustBalanceBody;
    const data = await adjustUserBalance(adminUserId(req), body.userId, body.amountCents, body.reason);
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------
 *  User moderation — suspend / unsuspend / ban / unban
 *
 *  All four are gated by `users.manage`. Enforcement is automatic: once
 *  `User.status` is SUSPENDED/BANNED, `middleware/telegramAuth` (requireActive)
 *  rejects that user with 403 on the whole API, so no other route changes.
 *  These endpoints move NO money — a moderated user's escrow/wallet/open
 *  campaigns are left untouched on purpose.
 * ------------------------------------------------------------------ */

/** Temporarily SUSPEND a user with a recorded reason. */
usersRouter.post(
  '/:id/suspend',
  requirePermission('users.manage'),
  validate({ params: idParams, body: moderationReasonSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as ModerationReasonBody;
      const data = await setUserSuspension(actorUserId(req), req.params.id, body.reason, moderationContext(req));
      respondOk(res, data);
    } catch (err) {
      next(err);
    }
  },
);

/** Lift a suspension — back to ACTIVE and clear the reason. */
usersRouter.post(
  '/:id/unsuspend',
  requirePermission('users.manage'),
  validate({ params: idParams, body: emptyBodySchema }),
  async (req, res, next) => {
    try {
      const data = await clearUserSuspension(actorUserId(req), req.params.id, moderationContext(req));
      respondOk(res, data);
    } catch (err) {
      next(err);
    }
  },
);

/** Permanently BAN a user with a recorded reason. */
usersRouter.post(
  '/:id/ban',
  requirePermission('users.manage'),
  validate({ params: idParams, body: moderationReasonSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as ModerationReasonBody;
      const data = await banUser(actorUserId(req), req.params.id, body.reason, moderationContext(req));
      respondOk(res, data);
    } catch (err) {
      next(err);
    }
  },
);

/** Lift a ban — back to ACTIVE and clear the reason. */
usersRouter.post(
  '/:id/unban',
  requirePermission('users.manage'),
  validate({ params: idParams, body: emptyBodySchema }),
  async (req, res, next) => {
    try {
      const data = await unbanUser(actorUserId(req), req.params.id, moderationContext(req));
      respondOk(res, data);
    } catch (err) {
      next(err);
    }
  },
);

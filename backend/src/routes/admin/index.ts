import { Router } from 'express';
import { adminPanelAuth } from '../../middleware/adminPanelAuth';
import { requireAdmin } from '../../middleware/adminAuth';
import { limiters } from '../../middleware/rateLimit';
import { adminUsersRouter } from './adminUsers.routes';
import { analyticsExtraRouter } from './analyticsExtra.routes';
import { analyticsRouter } from './analytics.routes';
import { attentionRouter } from './attention.routes';
import { blockedRouter } from './blocked.routes';
import { activityRouter } from './activity.routes';
import { apiLogsRouter } from './apiLogs.routes';
import { broadcastRouter } from './broadcast.routes';
import { adminAuthPublicRouter, adminAuthRouter } from './auth.routes';
import { campaignRouter } from './campaign.routes';
import { channelRouter } from './channel.routes';
import { cryptoAddressesRouter } from './cryptoAddresses.routes';
import { cryptoTransfersRouter } from './cryptoTransfers.routes';
import { dashboardRouter } from './dashboard.routes';
import { deliveryRouter } from './delivery.routes';
import { exportRouter } from './export.routes';
import { financeRouter } from './finance.routes';
import { moderationRouter } from './moderation.routes';
import { errorsRouter } from './errors.routes';
import { notificationsRouter } from './notifications.routes';
import { planPremiumRouter } from './premium.routes';
import { searchRouter } from './search.routes';
import { sessionRouter } from './session.routes';
import { systemStatusRouter } from './systemStatus.routes';
import { settingsRouter } from './settings.routes';
import { supportRouter } from './support.routes';
import { usersRouter } from './users.routes';

/**
 * Admin panel router (mounted by src/routes/index.ts).
 *
 * Two ways in, one gate:
 *  - `POST /api/admin/auth/login` (username + password) → a signed, self-expiring
 *    token sent back as `x-admin-token`. Rate limited separately and much more
 *    tightly (`limiters.adminLogin`).
 *  - Telegram initData, unchanged — every existing admin caller still works.
 *
 * `adminPanelAuth()` accepts either and converges them on one `req.user`, so
 * every endpoint below requires an active AdminUser record and is bounded by the
 * shared admin rate limiter. Finer-grained role checks (SUPER_ADMIN for managing
 * other admins, role-only gates on the settlement sweeps) live on the
 * sub-routers.
 */
export const adminRouter = Router();

// Reachable without credentials, so this must be registered BEFORE the auth gate
// below. Express applies `use(...)` in order, and only `config` + `login` live here.
adminRouter.use('/auth', adminAuthPublicRouter);

adminRouter.use(adminPanelAuth(), requireAdmin(), limiters.admin);

// Authenticated auth endpoints (me / logout / sessions). Registered after the
// gate, so they can assume a resolved identity.
adminRouter.use('/auth', adminAuthRouter);

// The acting admin's own role + permission keys. Gated by `requireAdmin` alone:
// an admin whose permission array is empty must still be able to read it, or the
// panel can only ever show a bare 403 with no way to explain itself.
adminRouter.use('/session', sessionRouter);

adminRouter.use('/dashboard', dashboardRouter);
adminRouter.use('/campaigns', campaignRouter);
adminRouter.use('/channels', channelRouter);
adminRouter.use('/users', usersRouter);
adminRouter.use('/delivery', deliveryRouter);
adminRouter.use('/finance', financeRouter);
adminRouter.use('/analytics', analyticsRouter);
adminRouter.use('/moderation', moderationRouter);
adminRouter.use('/support', supportRouter);
adminRouter.use('/settings', settingsRouter);
// Subscription plans: price and every benefit value, editable without a deploy.
adminRouter.use('/premium', planPremiumRouter);
// Per-network crypto deposit addresses: saving one is what puts that network on
// the deposit screen.
adminRouter.use('/crypto-addresses', cryptoAddressesRouter);
// Incoming on-chain transfers: what was seen, who to credit, what to ignore.
adminRouter.use('/crypto-transfers', cryptoTransfersRouter);
adminRouter.use('/admin-users', adminUsersRouter);
// CSV exports. Each file is gated by the matching `.view` permission and writes
// one audit row per export — user and financial data leaving the system is
// exactly the kind of event an audit trail exists for.
adminRouter.use('/export', exportRouter);
// Cross-entity search for the panel's top bar (spec §64). Bounded per entity and
// resilient: one failing entity does not fail the whole search.
adminRouter.use('/search', searchRouter);
// Additional read-only aggregates (campaign / delivery / user-growth / channel /
// funnel) that the panel previously had no source for.
adminRouter.use('/analytics', analyticsExtraRouter);
// Subsystem health board: api, database, redis, queues, telegram bot, webhook.
// Every probe is individually caught, so one dead dependency yields one UNKNOWN
// tile rather than a 500 for the whole board.
adminRouter.use('/system', systemStatusRouter);
// Blocked channels and blocked ad posts (spec §46–48). Note: `PublisherBlocklist`
// turned out to be a per-channel list scoped ADVERTISER|CAMPAIGN|CATEGORY|DOMAIN
// with `label` rather than `reason` — the routes use the model as it actually is.
adminRouter.use('/blocked', blockedRouter);
// A computed "needs attention" view, not a notification inbox: it is N count
// queries rendered on demand, so there is nothing to persist or mark as read.
adminRouter.use('/attention', attentionRouter);
// Broadcast to users. This is the route that finally makes the long-declared
// `broadcast.send` permission mean something; it fans out over the existing
// notification queue via `createBulkNotifications`, which until now had no caller.
adminRouter.use('/broadcast', broadcastRouter);
// The acting admin's own notification inbox. Same `notifications` table as the
// user inbox, keyed on the admin's own user id — deliberately not a second model.
adminRouter.use('/notifications', notificationsRouter);
// Persisted server failures (spec 84) and the merged external-call failures (27).
adminRouter.use('/errors', errorsRouter);
adminRouter.use('/api-logs', apiLogsRouter);
// The cross-entity activity stream (spec 65). Computed on read by merging recent
// rows, so there is nothing to keep in sync.
adminRouter.use('/activity', activityRouter);

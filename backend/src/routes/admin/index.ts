import { Router } from 'express';
import { telegramAuth } from '../../middleware/telegramAuth';
import { requireAdmin } from '../../middleware/adminAuth';
import { limiters } from '../../middleware/rateLimit';
import { adminUsersRouter } from './adminUsers.routes';
import { analyticsRouter } from './analytics.routes';
import { campaignRouter } from './campaign.routes';
import { channelRouter } from './channel.routes';
import { cryptoAddressesRouter } from './cryptoAddresses.routes';
import { cryptoTransfersRouter } from './cryptoTransfers.routes';
import { dashboardRouter } from './dashboard.routes';
import { deliveryRouter } from './delivery.routes';
import { financeRouter } from './finance.routes';
import { moderationRouter } from './moderation.routes';
import { planPremiumRouter } from './premium.routes';
import { settingsRouter } from './settings.routes';
import { supportRouter } from './support.routes';
import { usersRouter } from './users.routes';

/**
 * Admin panel router (mounted by src/routes/index.ts).
 *
 * Every endpoint requires a verified Telegram session AND an active AdminUser
 * record, and is bounded by the shared admin rate limiter. Finer-grained role
 * checks (e.g. SUPER_ADMIN for managing other admins) live on the
 * sub-routers.
 */
export const adminRouter = Router();

adminRouter.use(telegramAuth(), requireAdmin(), limiters.admin);

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

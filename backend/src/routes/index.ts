import { Router } from 'express';
import { telegramAuth } from '../middleware/telegramAuth';
import { meRouter } from './me.routes';
import { channelRouter } from './channel.routes';
import { marketplaceRouter } from './marketplace.routes';
import { campaignRouter } from './campaign.routes';
import { walletRouter } from './wallet.routes';
import { depositRouter } from './deposit.routes';
import { withdrawalRouter } from './withdrawal.routes';
import { analyticsRouter } from './analytics.routes';
import { referralRouter } from './referral.routes';
import { notificationRouter } from './notification.routes';
import { supportRouter } from './support.routes';
import { reportRouter } from './report.routes';
import { settingsRouter } from './settings.routes';
import { benefitsRouter } from './benefits.routes';
import { premiumRouter } from './premium.routes';
import { policyRouter } from './policy.routes';
import { trackApiRouter } from './track.routes';
import { apiKeyRouter } from './advertiserApi.routes';
import { webhookEndpointsRouter } from './webhookEndpoints.routes';
import { billingRouter } from './billing.routes';
import { emailRouter } from './email.routes';
import { aiRouter } from './ai.routes';

/**
 * The user-facing API router — mounted under `/api` in app.ts.
 *
 * EVERY route under /api requires Telegram Mini App authentication:
 * `telegramAuth()` runs once at the router level and sets `req.user`
 * (verifying the initData signature, auto-provisioning first-seen users).
 * Public endpoints (/health, /c/:slug, /webhook/*) never pass through here.
 *
 * All sub-routers declare their full paths and are mounted at the root of
 * this router; the admin panel is the only mounted prefix.
 */
export const router = Router();

router.use(telegramAuth());

router.use(meRouter);
router.use(channelRouter);
router.use(marketplaceRouter);
router.use(campaignRouter);
router.use(walletRouter);
router.use(depositRouter);
router.use(withdrawalRouter);
router.use(analyticsRouter);
router.use(referralRouter);
router.use(notificationRouter);
router.use(supportRouter);
router.use(reportRouter);
router.use(settingsRouter);
router.use(benefitsRouter);
router.use(premiumRouter);
router.use(policyRouter);

// Floating AI Assistant (/api/ai/chat, /api/ai/history). Telegram-authenticated
// like every other user route; the assistant persists its own transcript.
router.use(aiRouter);

// Programmatic access: key management (this file) and the key-authenticated
// public surface (publicApi.routes.ts, mounted at the app root — it must NOT
// inherit the telegramAuth above, see app.ts).
router.use(apiKeyRouter);

// Advertiser webhook endpoints + their delivery log.
router.use(webhookEndpointsRouter);

// Invoices and CSV/JSON statements.
router.use(billingRouter);

// Account email address and its verification flow.
router.use(emailRouter);

// Mini-App click recording (authenticated, so clicks are attributed).
router.use(trackApiRouter);

// The admin panel is NOT mounted here. It used to be (`router.use('/admin', ...)`),
// which put every /api/admin route behind the `telegramAuth()` above and made the
// panel's own auth — including its password login — unreachable from a browser:
// `/api/admin/auth/login` was rejected with "Telegram authentication required"
// before the login route ran. It is mounted in app.ts, before this router, the same
// way `publicApiRouter` is. Do not move it back.

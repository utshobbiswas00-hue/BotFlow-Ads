import { Router } from 'express';
import type { Request } from 'express';
import { env } from '../config/env';
import { limiters } from '../middleware/rateLimit';
import { logger } from '../config/logger';
import { resolveTrackingSlug, recordClick } from '../services/tracking.service';

/**
 * PUBLIC click-tracking endpoints — the busiest surface in the system.
 *
 * Two routers are exported and mounted at different levels:
 *   - `trackRouter`    → app root, serves `GET /c/:slug`
 *                        (the public 302 redirect written into every ad post)
 *   - `trackApiRouter` → under /api, serves `GET /api/track/click/:slug`
 *                        (called by the Mini App; authenticated, so the click
 *                         can be attributed to the user)
 *
 * Golden rule (see services/tracking.service.ts): tracking must NEVER break
 * the redirect. `recordClick` is fire-and-forget and swallows its own
 * failures; the only awaited work is the slug lookup that produces the
 * destination URL. Unknown / inactive slugs fall back to the Mini App.
 */

export const trackRouter = Router();
export const trackApiRouter = Router();

interface ClickContext {
  ip: string;
  userAgent: string;
  country: string | null;
  userId: string | null;
  telegramUserId: string | null;
}

/** Client metadata from the requestId context + the (optional) auth user. */
function clickContext(req: Request): ClickContext {
  return {
    ip: req.ctx?.ip ?? 'unknown',
    userAgent: req.ctx?.userAgent ?? 'unknown',
    // GeoIP is not deployed; honour a Cloudflare-style header if present.
    country: req.header('cf-ipcountry') ?? null,
    userId: req.user?.id ?? null,
    telegramUserId: req.user?.telegramId ?? null,
  };
}

function recordClickFireAndForget(slug: string, ctx: ClickContext): void {
  void recordClick({ slug, ...ctx }).catch((err) => {
    // recordClick never throws — this is a last-resort guard for the
    // fire-and-forget promise so the process never dies on a stray reject.
    logger.error({ err, slug }, 'recordClick fire-and-forget failed');
  });
}

/**
 * GET /c/:slug — public redirect. 302 to the advertiser's destination,
 * or to the Mini App when the slug is unknown/inactive/expired.
 */
trackRouter.get('/c/:slug', limiters.track, async (req, res, next) => {
  try {
    const slug = req.params.slug;
    const target = await resolveTrackingSlug(slug);

    recordClickFireAndForget(slug, clickContext(req));

    res.redirect(302, target?.destinationUrl ?? env.MINI_APP_URL);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/track/click/:slug — same recording for the Mini App, acked as JSON.
 * (Authenticated via the /api-level telegramAuth, so the click is attributed.)
 */
trackApiRouter.get('/track/click/:slug', limiters.track, async (req, res, next) => {
  try {
    const slug = req.params.slug;
    await resolveTrackingSlug(slug);

    recordClickFireAndForget(slug, clickContext(req));

    res.json({ ok: true, data: { recorded: true } });
  } catch (err) {
    next(err);
  }
});

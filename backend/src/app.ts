import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { env } from './config/env';
import { logger } from './config/logger';
import { requestId } from './middleware/requestId';
import { maintenanceGuard } from './middleware/maintenanceMode';
import { limiters } from './middleware/rateLimit';
import { notFoundHandler, errorHandler } from './middleware/errorHandler';
import { router } from './routes';
import { publicApiRouter } from './routes/publicApi.routes';
import { healthRouter } from './routes/health.routes';
import { trackRouter } from './routes/track.routes';
import { webhookRouter } from './routes/webhook.routes';

/* ------------------------------------------------------------------
 *  Mini App (SPA) hosting
 *
 *  The Vite build output is served from this same service, so the Mini App
 *  and its API share ONE origin. That removes three deployment moving parts
 *  that are easy to mis-wire: the CORS allowlist (no cross-origin request is
 *  made any more), the build-time VITE_API_URL (the SPA calls a relative
 *  `/api`), and the separate Render static-site service.
 *
 *  Nothing here is mounted when the build output is absent — a backend-only
 *  deploy, or local dev where Vite serves the SPA on :5173, behaves exactly
 *  as it did before.
 * ------------------------------------------------------------------ */

/** Paths that must never fall through to the SPA shell. */
const SPA_RESERVED_PREFIXES = ['/api', '/health', '/webhook', '/c'];

/**
 * Locate `frontend/dist`. `__dirname` is `<repo>/backend/dist` at runtime, so
 * `../../frontend/dist` is the repo-relative default; `SERVE_SPA_DIR` and
 * cwd are checked as overrides for non-standard layouts.
 */
function resolveSpaDir(): string | null {
  const candidates = [
    env.SERVE_SPA_DIR,
    path.resolve(__dirname, '../../frontend/dist'),
    path.resolve(process.cwd(), 'frontend/dist'),
  ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);

  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

/* ------------------------------------------------------------------
 *  BigInt safety net for JSON responses
 *
 *  Prisma returns BigInt for `telegramId` / `telegramMessageId`. If a
 *  handler ever forwards such a row straight to `res.json`,
 *  JSON.stringify throws "Do not know how to serialize a BigInt" and
 *  the request dies as a 500. This middleware wraps `res.json` once
 *  and converts every BigInt in the payload to a string, so no route
 *  can leak a raw row into the JSON encoder.
 * ------------------------------------------------------------------ */

function convertBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  // Pass through values whose identity matters (JSON.stringify knows them).
  if (value instanceof Date || Buffer.isBuffer(value) || value instanceof Error) return value;
  if (Array.isArray(value)) return value.map(convertBigInt);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = convertBigInt(val);
  }
  return out;
}

function bigintSafeJson() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const originalJson = res.json.bind(res);
    res.json = ((body?: unknown) =>
      originalJson(body === undefined ? undefined : convertBigInt(body))) as typeof res.json;
    next();
  };
}

/**
 * Assemble the Express app.
 *
 * Middleware ORDER MATTERS — do not reshuffle without reading the notes:
 *   1  helmet            security headers (CSP off for the Mini App)
 *   2  cors              only the Mini App origin, credentials allowed
 *   3  compression
 *   3b spa static       built Mini App assets + index.html (no-op when absent)
 *   4  requestId         x-request-id + client metadata (feeds logs/limits)
 *   5  bigintSafeJson    BigInt→string guard on res.json
 *   6  webhookRouter     BEFORE the body parsers — grammy parses its own
 *                        JSON and the payment webhook needs the RAW body
 *                        stream for HMAC verification (see webhook.routes.ts)
 *   7  body parsers      json (1mb) + urlencoded
 *   8  trust proxy       Render terminates TLS; req.ip must be the client
 *   8b publicApiRouter   API-key authenticated /api/v1 — BEFORE the /api
 *                        router (telegramAuth would otherwise reject it) and
 *                        before maintenanceGuard (a conversion postback must
 *                        not be lost to a maintenance window)
 *   9  maintenanceGuard  admin toggle (skips /health, /webhook, /c/, /api/admin)
 *   10 limiters.global   Redis-backed ceiling on all of /api
 *   11 /health           public probes
 *   12 /api router       all Telegram-authenticated user routes
 *   13 trackRouter       public /c/:slug click redirects
 *   13b spa fallback     non-API navigation → index.html (react-router routes)
 *   14 404 + errorHandler  every failure leaves a predictable JSON envelope
 */
export function createApp(): express.Express {
  const app = express();

  // 1. Security headers. CSP is disabled (the Mini App UI is served by
  //    Telegram, not us) and the API is allowed to serve cross-origin
  //    assets (fonts/images) to the Mini App.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // 2. CORS — the Mini App's origin only, with credentials.
  app.use(cors({ origin: [env.MINI_APP_URL], credentials: true }));

  // 3. Response compression.
  app.use(compression());

  // 3b. Built Mini App assets (see the SPA note above). Mounted BEFORE the
  //     maintenance switch on purpose: the shell has to load so it can render
  //     the maintenance notice. It is the API calls that the switch turns into
  //     503s, not the SPA.
  const spaDir = resolveSpaDir();
  const spaIndex = spaDir ? path.join(spaDir, 'index.html') : null;

  // Say which mode we booted in. This is the first thing to look at when the
  // Mini App shows "Route not found: GET /" — that response can only come from
  // an API-only boot, so this line tells you immediately whether the SPA was
  // found in the deployed filesystem.
  if (spaDir) {
    logger.info({ spaDir }, 'Mini App (SPA) is served from this service at /');
  } else {
    logger.warn(
      'frontend/dist not found — booting API-only, so GET / will return 404. ' +
        'Add `npm run build -w @botflow/frontend` to the build command (or set SERVE_SPA_DIR).',
    );
  }

  if (spaDir) {
    app.use(
      express.static(spaDir, {
        // The deep-link fallback near the bottom serves index.html, so this
        // must not answer `/` on its own.
        index: false,
        etag: true,
        setHeaders: (res, filePath) => {
          // Vite fingerprints every asset filename, so they never change.
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
  }

  // 4. Request id + client ip/user-agent context for every request.
  app.use(requestId);

  // 5. BigInt serialization guard (see note above).
  app.use(bigintSafeJson());

  // 6. Webhooks — MUST precede the body parsers (see webhook.routes.ts).
  app.use(webhookRouter);

  // 7. Body parsers (webhook routes already handled their own bodies).
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 8. Render sits behind a single proxy hop — trust it so req.ip is the
  //    real client IP (required for fraud windows and rate limiting).
  app.set('trust proxy', 1);

  // 8b. The key-authenticated advertiser API (`/api/v1/...`), deliberately
  //     BEFORE the `/api` user router — otherwise `telegramAuth` would reject
  //     every API-key request before it is ever seen. It also sits ahead of the
  //     maintenance switch, for the same reason `/webhook/payment` is exempt:
  //     a conversion postback is the advertiser's record of real money, and
  //     turning it away during a maintenance window loses it.
  app.use(publicApiRouter);

  // 9. Global maintenance switch (keeps /health, /webhook, /c/ and
  //    /api/admin working while it is ON).
  app.use(maintenanceGuard());

  // 10. Global API rate limit — one Redis counter shared by all instances.
  app.use('/api', limiters.global);

  // 11. Public health probes (Render uptime checks).
  app.use('/health', healthRouter);

  // 12. The user-facing API (telegramAuth inside — see routes/index.ts).
  app.use('/api', router);

  // 13. Public click-tracking redirect (busiest endpoint, unauthenticated).
  app.use(trackRouter);

  // 13b. SPA deep links. Any browser navigation that reached this point is a
  //      client-side route (`/wallet`, `/admin/users/…`), so hand back the
  //      shell and let react-router resolve it. Restricted to HTML-accepting
  //      GET/HEAD requests whose path is not an API or public surface, so a
  //      mistyped /api call still gets the JSON 404 envelope it deserves.
  if (spaIndex) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (!req.accepts('html')) return next();
      if (SPA_RESERVED_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
        return next();
      }
      res.sendFile(spaIndex, (err) => {
        if (err) next(err);
      });
    });
  }

  // 14. 404 fallback + central error translator (always last).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

import type { NextFunction, Request, Response } from 'express';
import { incrWindow } from '../db/redis';
import { RateLimitError } from '../utils/errors';
import { logger } from '../config/logger';
import { isTest } from '../config/env';

export interface RateLimitOptions {
  windowSeconds: number;
  max: number;
  /** Key strategy. 'user' falls back to IP when unauthenticated. */
  scope?: 'ip' | 'user' | 'telegram';
  prefix?: string;
  message?: string;
  /**
   * Enforce the limit from an in-process counter when Redis cannot answer.
   *
   * Only for credentials where "no limit at all" is worse than "a limit that is
   * merely per-instance": a Redis outage used to fail every limiter open, which
   * removed the brute-force protection on `POST /api/admin/auth/login` exactly when
   * the rest of the system was already degraded. The fallback is per-container and
   * therefore weaker under scale-out than the shared counter — which is why it is
   * opt-in per limiter rather than the default.
   */
  emergencyLocalFallback?: boolean;
}

/**
 * Redis-backed fixed-window rate limiter.
 *
 * Uses a single INCR+EXPIRE pipeline so the limit holds across every
 * Render instance — an in-memory limiter would be trivially bypassed
 * once the web service scales beyond one container.
 */
export function rateLimit(options: RateLimitOptions) {
  const { windowSeconds, max, scope = 'ip', prefix = 'rl', message, emergencyLocalFallback } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (isTest) return next();

    try {
      const key = `${prefix}:${scope}:${resolveIdentity(req, scope)}:${bucket(req, windowSeconds)}`;
      const count = await incrWindow(key, windowSeconds);

      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));

      if (count > max) {
        const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
        res.setHeader('Retry-After', retryAfter);
        throw new RateLimitError(message ?? 'Too many requests, please slow down', retryAfter);
      }

      next();
    } catch (err) {
      if (err instanceof RateLimitError) {
        logger.warn({ key: prefix, path: req.path, ip: req.ctx?.ip }, 'rate limit exceeded');
        next(err);
        return;
      }
      // A Redis outage must not take the API down, so the default is still to fail
      // open. Limiters that guard credentials opt into the local counter instead.
      if (emergencyLocalFallback) {
        const key = `${prefix}:${scope}:${resolveIdentity(req, scope)}:${bucket(req, windowSeconds)}`;
        const count = localIncr(key, windowSeconds);
        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));
        if (count > max) {
          const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
          res.setHeader('Retry-After', retryAfter);
          logger.warn(
            { key: prefix, path: req.path, ip: req.ctx?.ip, count },
            'rate limit exceeded (in-process fallback)',
          );
          next(new RateLimitError(message ?? 'Too many requests, please slow down', retryAfter));
          return;
        }
        logger.error(
          { err, key: prefix, path: req.path },
          'rate limiter unavailable — enforcing the limit from the in-process fallback',
        );
        next();
        return;
      }

      logger.error({ err }, 'rate limiter unavailable, failing open');
      next();
    }
  };
}

/**
 * Fixed-window counter kept in this process, for the limiters that must not become
 * unlimited while Redis is unreachable.
 *
 * Deliberately bounded: it only exists during an outage, and the sweep keeps a long
 * outage from turning into a slow memory leak.
 */
const localWindows = new Map<string, { count: number; expiresAtMs: number }>();

function localIncr(key: string, windowSeconds: number): number {
  const now = Date.now();
  const entry = localWindows.get(key);
  if (!entry || entry.expiresAtMs <= now) {
    if (localWindows.size >= 10_000) {
      for (const [k, v] of localWindows) {
        if (v.expiresAtMs <= now) localWindows.delete(k);
      }
    }
    localWindows.set(key, { count: 1, expiresAtMs: now + windowSeconds * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

function resolveIdentity(req: Request, scope: RateLimitOptions['scope']): string {
  if (scope === 'user' && req.user) return req.user.id;
  if (scope === 'telegram' && req.user) return req.user.telegramId;
  return req.ctx?.ip ?? 'unknown';
}

/** Fixed window bucket id — all requests inside the same window share a bucket. */
function bucket(req: Request, windowSeconds: number): number {
  return Math.floor(Date.now() / 1000 / windowSeconds);
}

/* ----------------------------------------------------------------
 *  Pre-built limiters for the routes that need protection
 * ---------------------------------------------------------------- */

export const limiters = {
  /** Global API ceiling per IP. */
  global: rateLimit({ windowSeconds: 60, max: 300, prefix: 'rl:global' }),

  /** Auth / account bootstrap — expensive (DB writes on first sight). */
  auth: rateLimit({
    windowSeconds: 60,
    max: 30,
    prefix: 'rl:auth',
    emergencyLocalFallback: true,
  }),

  /** Creating campaigns is expensive and a classic abuse vector. */
  createCampaign: rateLimit({ windowSeconds: 3600, max: 20, prefix: 'rl:campaign', scope: 'user' }),

  /** Adding channels — hits the Telegram API, so keep it tight. */
  addChannel: rateLimit({ windowSeconds: 3600, max: 10, prefix: 'rl:channel', scope: 'user' }),

  /** Deposit creation. */
  deposit: rateLimit({ windowSeconds: 3600, max: 15, prefix: 'rl:deposit', scope: 'user' }),

  /** Withdrawal requests — the highest-risk endpoint in the system. */
  withdrawal: rateLimit({ windowSeconds: 3600, max: 5, prefix: 'rl:withdraw', scope: 'user' }),

  /** Support tickets. */
  support: rateLimit({ windowSeconds: 3600, max: 10, prefix: 'rl:support', scope: 'user' }),

  /** Public click-tracking redirect — the busiest endpoint by far. */
  track: rateLimit({ windowSeconds: 60, max: 240, prefix: 'rl:track' }),

  /** Admin actions. */
  admin: rateLimit({ windowSeconds: 60, max: 200, prefix: 'rl:admin', scope: 'user' }),

  /**
   * Staff panel password login — deliberately hostile.
   *
   * The panel holds every financial control in the product behind one password,
   * so this is the one endpoint where a slow-and-narrow limiter is worth the
   * support cost. 10 attempts per IP per 15 minutes makes an online dictionary
   * attack useless without locking out a legitimate operator who mistypes twice.
   * Scoped by IP (the default), because there is no authenticated user yet.
   */
  adminLogin: rateLimit({
    windowSeconds: 900,
    max: 10,
    prefix: 'rl:adminlogin',
    // Password guessing must not become unlimited because Redis is down.
    emergencyLocalFallback: true,
  }),

  /** Webhook endpoints — generous, but bounded. */
  webhook: rateLimit({ windowSeconds: 60, max: 1000, prefix: 'rl:webhook' }),
};

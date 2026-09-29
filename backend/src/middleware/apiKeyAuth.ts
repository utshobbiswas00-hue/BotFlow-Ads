import type { NextFunction, Request, Response } from 'express';
import type { ApiKeyScope } from '@botflow/shared';
import { resolveApiKey } from '../services/apiKey.service';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { logger } from '../config/logger';

/**
 * API-key authentication for the public advertiser API (/api/v1/*).
 *
 * These endpoints are reachable WITHOUT Telegram sign-in — the key IS the
 * identity. The key's owner is the only account any handler may read from.
 *
 * The presented key is never logged — not even the secret part's prefix.
 */

export interface AuthenticatedApiKey {
  id: string;
  /** The advertiser account this key belongs to. */
  userId: string;
  scopes: ApiKeyScope[];
}

declare global {
  namespace Express {
    interface Request {
      /** Set by `apiKeyAuth` — present when an API key authenticated the request. */
      apiKey?: AuthenticatedApiKey;
    }
  }
}

/**
 * Read the key from `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 * Header access is direct (no `req.header`) so the middleware can be exercised
 * with plain objects in tests.
 */
function extractPresentedKey(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.length > 0) {
    const [scheme, ...rest] = auth.split(' ');
    if (scheme.toLowerCase() === 'bearer') {
      const token = rest.join(' ').trim();
      return token.length > 0 ? token : null;
    }
    // An Authorization header that is not a Bearer token cannot carry a key.
    return null;
  }

  const xApiKey = req.headers['x-api-key'];
  const value = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Best-effort client IP for lastUsedIp. Uses Express's proxy-aware resolution
 * (`req.ip`) rather than the raw `X-Forwarded-For` header, whose left-most
 * entry is client-controlled and would forge the recorded last-used address.
 */
function requestIp(req: Request): string | null {
  const ip = (req as { ip?: string }).ip;
  return typeof ip === 'string' && ip.length > 0 ? ip : null;
}

/**
 * Authenticate the request with an BotFlow API key.
 *
 * On success sets `req.apiKey = { id, userId, scopes }`. On failure calls
 * next() with an UnauthorizedError carrying a plain-language message
 * (missing / invalid / revoked / expired are all distinguished).
 */
export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const presented = extractPresentedKey(req);
    if (!presented) {
      throw new UnauthorizedError(
        'Missing API key. Send it as "Authorization: Bearer <key>" or the "X-API-Key" header.',
      );
    }

    const row = await resolveApiKey(presented, requestIp(req));
    req.apiKey = { id: row.id, userId: row.userId, scopes: row.scopes as unknown as ApiKeyScope[] };
    next();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // Log the failure reason only — NEVER the presented key.
      logger.warn({ message: err.message }, 'API key auth failed');
    }
    next(err);
  }
}

/**
 * Scope guard for API-key routes, exported alongside `apiKeyAuth`.
 *
 *   publicApiRouter.post('/api/v1/conversions', limiter, apiKeyAuth, requireScope('WRITE'), handler)
 *
 * 401 when no key is present (the route was hit without apiKeyAuth), 403 when
 * the key is valid but lacks the scope.
 */
export function requireScope(scope: ApiKeyScope) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.apiKey) {
      next(new UnauthorizedError('Missing API key.'));
      return;
    }
    if (!req.apiKey.scopes.includes(scope)) {
      next(
        new ForbiddenError(
          `This API key does not have the ${scope} scope. Recreate it with ${scope} (plus any scopes you need) to use this endpoint.`,
        ),
      );
      return;
    }
    next();
  };
}

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const HEADER = 'x-request-id';

/**
 * Attaches a request id (and client metadata) to every request.
 * The id is echoed back in the response header so a user-reported error
 * can be traced to an exact log line.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(HEADER);
  const id = incoming && incoming.length <= 128 ? incoming : crypto.randomUUID();

  req.ctx = {
    requestId: id,
    ip: clientIp(req),
    userAgent: req.header('user-agent') ?? 'unknown',
    startedAt: Date.now(),
  };

  res.setHeader(HEADER, id);
  next();
}

/**
 * Resolve the real client IP behind Render's proxy.
 *
 * Always use Express's own resolution (`req.ip`), which honours the trusted
 * proxy hop(s) configured via `app.set('trust proxy', ...)`. Parsing
 * `X-Forwarded-For` here would return the left-most, attacker-controlled
 * entry — that value feeds every IP rate limiter and fraud window, so it must
 * never be trusted directly.
 */
export function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}

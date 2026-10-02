import crypto from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { redis } from '../db/redis';

/**
 * Server-side session store for the staff panel.
 *
 * Redis-backed, so a session survives a deploy and is shared by every instance.
 * The store is a plain key/value with a TTL rather than a session library: the
 * panel needs create / read / refresh / destroy / list, and four primitives do
 * not justify new dependencies.
 *
 * Two design decisions worth stating, because both are load-bearing:
 *
 * 1. **The Redis key is the SHA-256 of the session id, not the id itself.** What
 *    the browser holds and the server stores are therefore different strings, so
 *    a leaked Redis dump (a backup, a DEBUG output, a provider snapshot) cannot
 *    be replayed as a live session. A lookup still costs one GET.
 *
 * 2. **The CSRF token lives in the session record, not in the cookie.** The
 *    standard double-submit pattern compares a cookie against a header, which an
 *    attacker who can set a cookie on the victim's browser (a subdomain takeover,
 *    a sibling app on the same registrable domain) can satisfy on their own. With
 *    the expected value stored server-side, only the value issued at login is
 *    accepted, and rotating it on login kills session fixation.
 *
 * Fallback: when Redis is not `ready` — ioredis is configured with
 * `maxRetriesPerRequest: null`, so touching it while the socket is down would
 * hang rather than fail — sessions fall back to an in-process map. Those sessions
 * die with the process and are NOT shared between instances, which is correct for
 * a single-instance deployment and a hard limit on a multi-instance one. That is
 * logged loudly rather than hidden.
 */

const SESSION_PREFIX = 'admin:sess:';
const INDEX_PREFIX = 'admin:sess:idx:';

export interface AdminSessionRecord {
  adminId: string;
  /** The value the client must echo in `x-csrf-token`. */
  csrf: string;
  createdAt: string;
  ip: string;
  userAgent: string;
}

export interface CreatedSession {
  /** Goes into the HttpOnly cookie. Never logged, never returned in a body. */
  sid: string;
  csrf: string;
  expiresAt: string;
  ttlSeconds: number;
}

function ttlSeconds(): number {
  return Math.max(60, env.ADMIN_PANEL_SESSION_TTL_HOURS * 3600);
}

/** The Redis key for a session id — hashed, so the stored key is not the credential. */
function sessionKey(sid: string): string {
  return `${SESSION_PREFIX}${crypto.createHash('sha256').update(sid).digest('hex')}`;
}

function indexKey(adminId: string): string {
  return `${INDEX_PREFIX}${adminId}`;
}

function newSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/* ------------------------------------------------------------------
 *  In-process fallback (Redis unavailable)
 * ------------------------------------------------------------------ */

interface MemoryEntry {
  record: AdminSessionRecord;
  expiresAtMs: number;
}

const memory = new Map<string, MemoryEntry>();
let warnedAboutFallback = false;

function usingMemory(): boolean {
  return redis.status !== 'ready';
}

function noteFallback(): void {
  if (warnedAboutFallback) return;
  warnedAboutFallback = true;
  logger.warn(
    'admin sessions are running from the in-process fallback because Redis is not ready — ' +
      'sessions will not survive a restart and will not be shared across instances',
  );
}

function memorySweep(): void {
  const now = Date.now();
  for (const [key, entry] of memory) {
    if (entry.expiresAtMs <= now) memory.delete(key);
  }
}

/* ------------------------------------------------------------------
 *  Public API
 * ------------------------------------------------------------------ */

export async function createSession(input: {
  adminId: string;
  ip: string;
  userAgent: string;
}): Promise<CreatedSession> {
  const sid = newSecret();
  const csrf = newSecret();
  const ttl = ttlSeconds();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  const record: AdminSessionRecord = {
    adminId: input.adminId,
    csrf,
    createdAt: new Date().toISOString(),
    ip: input.ip,
    userAgent: input.userAgent,
  };

  const key = sessionKey(sid);

  if (usingMemory()) {
    noteFallback();
    memorySweep();
    memory.set(key, { record, expiresAtMs: Date.now() + ttl * 1000 });
  } else {
    try {
      await redis
        .multi()
        .set(key, JSON.stringify(record), 'EX', ttl)
        .sadd(indexKey(input.adminId), key)
        .exec();
    } catch (err) {
      // A login that cannot be stored must fail loudly: silently degrading to a
      // session nobody can read would look like "the password was wrong".
      logger.error({ err: (err as Error).message }, 'admin session: could not write session to redis');
      throw err;
    }
  }

  return { sid, csrf, expiresAt, ttlSeconds: ttl };
}

export async function readSession(sid: string): Promise<AdminSessionRecord | null> {
  if (!sid) return null;
  const key = sessionKey(sid);

  if (usingMemory()) {
    const entry = memory.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      memory.delete(key);
      return null;
    }
    // Sliding expiry, matching the Redis path.
    entry.expiresAtMs = Date.now() + ttlSeconds() * 1000;
    return entry.record;
  }

  try {
    const raw = await redis.get(key);
    if (!raw) return null;

    let record: AdminSessionRecord;
    try {
      record = JSON.parse(raw) as AdminSessionRecord;
    } catch {
      // Unparseable: treat as absent and drop it rather than 500 on every request.
      await redis.del(key);
      return null;
    }
    if (!record.adminId || !record.csrf) {
      await redis.del(key);
      return null;
    }

    // Sliding expiry. Fire-and-forget: a failed refresh shortens the session but
    // must not fail the request that is otherwise perfectly authorised.
    void redis.expire(key, ttlSeconds()).catch(() => undefined);

    return record;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'admin session: could not read session from redis');
    // Fail closed. An unreadable store must not mean "authenticated".
    return null;
  }
}

export async function destroySession(sid: string): Promise<void> {
  if (!sid) return;
  const key = sessionKey(sid);

  if (usingMemory()) {
    memory.delete(key);
    return;
  }

  try {
    const raw = await redis.get(key);
    const adminId = raw ? (JSON.parse(raw) as AdminSessionRecord).adminId : null;
    const pipeline = redis.multi();
    pipeline.del(key);
    if (adminId) pipeline.srem(indexKey(adminId), key);
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'admin session: destroy failed — the TTL will retire it');
  }
}

export interface SessionSummary {
  /** Last 12 characters, enough to tell sessions apart in a UI, useless to an attacker. */
  fingerprint: string;
  createdAt: string;
  ip: string;
  userAgent: string;
}

/**
 * Every live session for one admin.
 *
 * The index is a Redis set that is trimmed lazily: entries whose key has already
 * expired are dropped when encountered. A set that outlives its keys is harmless
 * (it only ever causes a miss), so there is no need for a sweeper.
 */
export async function listSessions(adminId: string): Promise<SessionSummary[]> {
  if (usingMemory()) {
    memorySweep();
    const out: SessionSummary[] = [];
    for (const [key, entry] of memory) {
      if (entry.record.adminId !== adminId) continue;
      out.push(summarise(key, entry.record));
    }
    // Newest first, matching the Redis path below — the fallback used during a
    // Redis outage must present the same ordering, not Map insertion order.
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  try {
    const keys = await redis.smembers(indexKey(adminId));
    if (keys.length === 0) return [];

    const values = await redis.mget(...keys);
    const out: SessionSummary[] = [];
    const stale: string[] = [];

    keys.forEach((key, i) => {
      const raw = values[i];
      if (!raw) {
        stale.push(key);
        return;
      }
      try {
        const record = JSON.parse(raw) as AdminSessionRecord;
        out.push(summarise(key, record));
      } catch {
        stale.push(key);
      }
    });

    if (stale.length) void redis.srem(indexKey(adminId), ...stale).catch(() => undefined);

    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'admin session: could not list sessions');
    return [];
  }
}

function summarise(key: string, record: AdminSessionRecord): SessionSummary {
  return {
    // The key is a hash, so this reveals nothing about the session id.
    fingerprint: key.slice(-12),
    createdAt: record.createdAt,
    ip: record.ip,
    userAgent: record.userAgent,
  };
}

/** Sign out everywhere. Used when an admin changes their password or suspects a leak. */
export async function destroyAllSessions(adminId: string): Promise<number> {
  if (usingMemory()) {
    let removed = 0;
    for (const [key, entry] of memory) {
      // Only this admin's sessions. Getting this comparison the wrong way round
      // would sign out every OTHER admin and leave the caller signed in.
      if (entry.record.adminId === adminId) {
        memory.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  try {
    const keys = await redis.smembers(indexKey(adminId));
    const pipeline = redis.multi();
    if (keys.length) pipeline.del(...keys);
    pipeline.del(indexKey(adminId));
    await pipeline.exec();
    return keys.length;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'admin session: bulk destroy failed');
    return 0;
  }
}

/** Constant-time compare for the CSRF token. */
export function csrfMatches(expected: string, provided: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Test hook: drop the in-process fallback state between cases. */
export function __resetMemorySessionsForTest(): void {
  memory.clear();
  warnedAboutFallback = false;
}

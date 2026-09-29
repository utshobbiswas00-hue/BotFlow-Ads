import { redis } from '../db/redis';
import { IDEMPOTENCY_TTL_SECONDS } from '../config/constants';
import { logger } from '../config/logger';

/**
 * Idempotency guard.
 *
 * The single most important defence against double-crediting money:
 * a payment gateway retrying a webhook, a user double-tapping "Deposit",
 * or a worker re-running a job must never move funds twice.
 *
 * Two layers are used together:
 *   1. Redis SET NX lock  → fast rejection of concurrent duplicates
 *   2. DB unique index on `transactions.reference` → durable guarantee
 *      even if Redis is flushed or unavailable.
 *
 * Always pair this with a unique `reference` on the transaction row.
 */

const PREFIX = 'idem:';

export interface IdempotencyResult<T> {
  /** false when this key had already been seen — `result` holds the first value. */
  executed: boolean;
  result: T | null;
}

/**
 * Execute `fn` at most once per `key` within the TTL.
 * If the key already completed, the stored result is returned instead.
 */
export async function withIdempotency<T>(
  key: string,
  fn: () => Promise<T>,
  options: { ttlSeconds?: number; throwOnDuplicate?: boolean } = {},
): Promise<IdempotencyResult<T>> {
  const ttl = options.ttlSeconds ?? IDEMPOTENCY_TTL_SECONDS;
  const redisKey = `${PREFIX}${key}`;
  const doneKey = `${PREFIX}done:${key}`;

  // Fast path: already completed.
  const cached = await redis.get(doneKey);
  if (cached !== null) {
    logger.debug({ key }, 'idempotency: replay hit');
    return { executed: false, result: safeJsonParse<T>(cached) };
  }

  // Lock. NX ensures only one caller proceeds.
  const lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const acquired = await redis.set(redisKey, lockValue, 'EX', ttl, 'NX');

  if (acquired !== 'OK') {
    // Another worker is currently running this key.
    logger.warn({ key }, 'idempotency: concurrent duplicate blocked');
    if (options.throwOnDuplicate) {
      throw new Error(`Idempotent operation already in progress for key: ${key}`);
    }
    // Wait briefly for the first caller to publish its result.
    for (let i = 0; i < 10; i += 1) {
      await sleep(150);
      const after = await redis.get(doneKey);
      if (after !== null) return { executed: false, result: safeJsonParse<T>(after) };
    }
    return { executed: false, result: null };
  }

  try {
    const result = await fn();
    // Cache the outcome so retries return the same answer.
    await redis.set(doneKey, JSON.stringify(result ?? null), 'EX', ttl);
    // NOTE: on success `redisKey` is deliberately left in place until its TTL
    // so an in-flight duplicate stays blocked. The previous `finally` deleted
    // it immediately, contradicting the comment and re-opening the window.
    return { executed: true, result };
  } catch (err) {
    // Release the lock so a genuine retry can succeed.
    await redis.del(redisKey).catch(() => undefined);
    throw err;
  }
}

/** Simple distributed lock for cron-style "only one instance" work. */
export async function acquireLock(
  name: string,
  ttlSeconds: number,
): Promise<{ acquired: boolean; release: () => Promise<void> }> {
  const key = `lock:${name}`;
  const value = `${process.pid}-${Date.now()}`;
  const ok = await redis.set(key, value, 'EX', ttlSeconds, 'NX');
  return {
    acquired: ok === 'OK',
    release: async () => {
      const current = await redis.get(key);
      if (current === value) await redis.del(key);
    },
  };
}

/** Build a deterministic key from parts, so callers cannot forget separators. */
export function idemKey(...parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== '')
    .map((p) => String(p).trim().toLowerCase())
    .join(':');
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

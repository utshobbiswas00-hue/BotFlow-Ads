import Redis, { type RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Shared Redis connection used for:
 *  - BullMQ queues
 *  - rate limiting
 *  - idempotency locks
 *  - cached settings
 *
 * Render Key Value exposes a standard redis:// URL. BullMQ requires
 * `maxRetriesPerRequest: null` on its own connections, so we expose a
 * factory for that instead of reusing this client.
 */
const isTls = env.REDIS_URL.startsWith('rediss://');

// Verify the Redis server certificate by default. An explicit, deliberate
// opt-out is required (e.g. a managed provider with a private CA) — never a
// silent downgrade that lets an on-path attacker terminate the TLS session.
const rejectUnauthorized = process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false';

const baseOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
  ...(isTls ? { tls: { rejectUnauthorized } } : {}),
};

const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(env.REDIS_URL, {
    ...baseOptions,
    connectionName: 'botflow-main',
  });

redis.on('error', (err) => logger.error({ err: err.message }, 'redis error'));
redis.on('reconnecting', () => logger.warn('redis reconnecting'));
redis.on('ready', () => logger.info('redis ready'));

if (env.NODE_ENV !== 'production') globalForRedis.redis = redis;

/** Create a dedicated connection for a BullMQ Queue/Worker. */
export function createQueueConnection(name = 'botflow-queue'): Redis {
  return new Redis(env.REDIS_URL, {
    ...baseOptions,
    connectionName: name,
  });
}

export async function pingRedis(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------
 *  Small helpers used across services
 * ------------------------------------------------------------------ */

/**
 * A cache must never be able to take the platform down.
 *
 * `maxRetriesPerRequest: null` (which BullMQ demands on its own connections)
 * makes ioredis QUEUE commands instead of rejecting them while the socket is
 * down. On this shared client that would turn a Redis outage into a hang on a
 * money path — loading settings would await forever rather than fall back to
 * Postgres. So: if the client is not `ready`, skip the cache entirely and let
 * the caller read from the database. Every helper is additionally wrapped so a
 * mid-flight failure degrades to "cache miss" rather than an exception.
 */
function cacheUsable(): boolean {
  return redis.status === 'ready';
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!cacheUsable()) return null;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, key }, 'cache get failed — falling through to source');
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!cacheUsable()) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn({ err: (err as Error).message, key }, 'cache set failed — value not cached');
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (!keys.length || !cacheUsable()) return;
  try {
    await redis.del(...keys);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'cache del failed — stale value will expire by TTL');
  }
}

/**
 * Sliding-window counter. Returns the current count inside the window.
 * Used by the rate limiter and the click-flood fraud rule.
 */
export async function incrWindow(key: string, windowSeconds: number): Promise<number> {
  const pipeline = redis.multi();
  pipeline.incr(key);
  pipeline.expire(key, windowSeconds, 'NX');
  const results = await pipeline.exec();
  const count = results?.[0]?.[1];
  return typeof count === 'number' ? count : Number(count ?? 1);
}

export async function gracefulRedisShutdown(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

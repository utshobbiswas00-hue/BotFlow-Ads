/**
 * Pure, dependency-free helpers for the admin system-status board
 * (systemStatus.routes.ts).
 *
 * Zero imports on purpose: the status board must not be able to drag in Prisma,
 * Redis or a BullMQ connection just to translate a probe result into a
 * subsystem state, and these functions can be unit-tested with no database.
 *
 * A `detail` string is ALWAYS a short, safe, human sentence. It must never carry
 * a secret, a connection string or a raw error — those would leak through the
 * admin panel (and any screenshot of it).
 */

export type SubsystemState = 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';

export interface SubsystemStatus {
  name: string;
  status: SubsystemState;
  detail: string;
  checkedAt: string;
}

/** Thousands separators without depending on the runtime's ICU data. */
export function formatCount(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Map the queue probe to a subsystem state.
 *
 * `redisUp` is passed in explicitly because when Redis is down, asking BullMQ
 * for job counts would block (its connections queue commands) — the caller must
 * short-circuit before calling `getQueueHealth()`.
 */
export function queueStatus(
  redisUp: boolean,
  queues: Array<{ failed: number }>,
): { status: SubsystemState; detail: string } {
  if (!redisUp) {
    return { status: 'OFFLINE', detail: 'Redis is down, so the job queues cannot be reached.' };
  }
  const failed = queues.reduce((sum, q) => sum + (q.failed ?? 0), 0);
  if (failed > 0) {
    return { status: 'DEGRADED', detail: `${queues.length} queues, ${formatCount(failed)} failed jobs.` };
  }
  return { status: 'ONLINE', detail: `${queues.length} queues, no failed jobs.` };
}

/** Map recent `WebhookDelivery` counts (last 24h) to a subsystem state. */
export function webhookStatus(counts: { total: number; failed: number }): {
  status: SubsystemState;
  detail: string;
} {
  if (counts.total === 0) {
    return { status: 'ONLINE', detail: 'No webhook deliveries in the last 24h.' };
  }
  if (counts.failed > 0) {
    return {
      status: 'DEGRADED',
      detail: `${formatCount(counts.total)} deliveries in the last 24h, ${formatCount(counts.failed)} failed.`,
    };
  }
  return { status: 'ONLINE', detail: `${formatCount(counts.total)} deliveries in the last 24h, none failed.` };
}

/**
 * Map a cached bot identity to a subsystem state.
 *
 * `null` means no cached identity is available — reported as UNKNOWN rather than
 * guessing, and never resolved by firing a live Telegram call from the board.
 */
export function botStatus(self: { username?: string } | null): { status: SubsystemState; detail: string } {
  if (!self) {
    return { status: 'UNKNOWN', detail: 'Telegram bot identity is not cached; no live probe performed.' };
  }
  return { status: 'ONLINE', detail: 'Telegram bot identity is cached (getMe succeeded).' };
}

/**
 * Resolve `promise` but give up after `ms`, returning `fallback`. A status page
 * must never hang on a single slow dependency.
 *
 * Note: this stops us awaiting the work, it does not cancel it.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

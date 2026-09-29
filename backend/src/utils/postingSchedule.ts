import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import type { PostingSchedule } from '@botflow/shared';
import { env } from '../config/env';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * How long a scheduled slot stays open.
 *
 * The dispatcher is not a cron: a job that falls due at 09:00 may be picked up
 * minutes later, and a slot that shut the instant it opened would starve the
 * campaign rather than pace it. Thirty minutes absorbs normal queue and
 * database latency while staying far shorter than the gap between any two
 * slots a publisher can realistically set.
 */
export const SLOT_GRACE_MS = 30 * 60 * 1000;

/** The platform's clock. Publisher times are read in this timezone. */
export function platformTimeZone(): string {
  return env.TZ || 'Asia/Dhaka';
}

/**
 * Narrow whatever the database holds into a schedule.
 *
 * The column is `Json?`, so Prisma can only promise `JsonValue`. The shared Zod
 * schema validates every write, but a row written before this feature existed —
 * or edited by hand — must not be able to crash a delivery worker, so the shape
 * is checked here rather than asserted.
 */
function asSchedule(value: unknown): PostingSchedule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as PostingSchedule;
}

/** A weekday's times, dropping anything malformed rather than guessing. */
function slotsFor(schedule: PostingSchedule, weekday: number): Array<{ h: number; m: number }> {
  const times = schedule[String(weekday)];
  if (!Array.isArray(times)) return [];
  return times.flatMap((time) => {
    const [h, m] = String(time).split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? [{ h, m }] : [];
  });
}

/**
 * Milliseconds to wait before a post may go out in a channel.
 *
 * `0` means "now is inside one of the publisher's slots". Anything else is the
 * wait until the next one, which callers hand to the queue as a delay. A
 * channel with no schedule returns 0 — the publisher simply has not set one,
 * and the daily/interval limits still apply.
 *
 * Times are read in the platform timezone (`TZ`, Asia/Dhaka by default), which
 * is what the publisher picked them in.
 */
export function msUntilAllowedSlot(value: unknown, nowMs: number = Date.now()): number {
  const schedule = asSchedule(value);
  if (!schedule) return 0;

  const hasAnySlot = Object.keys(schedule).some(
    (day) => Number(day) >= 0 && Number(day) <= 6 && slotsFor(schedule, Number(day)).length > 0,
  );
  if (!hasAnySlot) return 0;

  const now = dayjs(nowMs).tz(platformTimeZone());

  // Today first: is a slot open right now?
  for (const { h, m } of slotsFor(schedule, now.day())) {
    const wait = now.hour(h).minute(m).second(0).millisecond(0).valueOf() - nowMs;
    if (wait <= 0 && -wait < SLOT_GRACE_MS) return 0;
  }

  // Otherwise the wait is the nearest upcoming slot, looking at most a week
  // ahead (a week covers every weekday key, so the search always terminates on
  // a valid slot rather than falling through).
  let soonest = Infinity;
  for (let ahead = 0; ahead <= 7 && soonest === Infinity; ahead += 1) {
    const day = now.add(ahead, 'day');
    for (const { h, m } of slotsFor(schedule, day.day())) {
      const slotMs = day.hour(h).minute(m).second(0).millisecond(0).valueOf();
      if (slotMs > nowMs && slotMs - nowMs < soonest) soonest = slotMs - nowMs;
    }
  }

  return Number.isFinite(soonest) ? soonest : 0;
}

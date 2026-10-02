import { describe, expect, it } from 'vitest';
import {
  botStatus,
  formatCount,
  queueStatus,
  webhookStatus,
  withTimeout,
} from '../systemStatus.helpers';

/**
 * DB-FREE unit tests for the pure system-status helpers.
 *
 * The mapping functions are what turn an infrastructure probe into the exact
 * ONLINE / DEGRADED / OFFLINE / UNKNOWN tile the board renders, and the detail
 * strings are user-visible — so they are pinned here without touching Prisma,
 * Redis or Telegram.
 */

describe('formatCount', () => {
  it('adds thousands separators', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(3)).toBe('3');
    expect(formatCount(1204)).toBe('1,204');
    expect(formatCount(1234567)).toBe('1,234,567');
  });

  it('truncates fractions', () => {
    expect(formatCount(9.9)).toBe('9');
  });
});

describe('queueStatus', () => {
  it('is OFFLINE when Redis is down', () => {
    expect(queueStatus(false, [])).toEqual({
      status: 'OFFLINE',
      detail: 'Redis is down, so the job queues cannot be reached.',
    });
  });

  it('is DEGRADED when any queue has failed jobs', () => {
    expect(queueStatus(true, [{ failed: 0 }, { failed: 3 }])).toEqual({
      status: 'DEGRADED',
      detail: '2 queues, 3 failed jobs.',
    });
  });

  it('is ONLINE when every queue has zero failures', () => {
    expect(queueStatus(true, [{ failed: 0 }, { failed: 0 }])).toEqual({
      status: 'ONLINE',
      detail: '2 queues, no failed jobs.',
    });
  });
});

describe('webhookStatus', () => {
  it('is ONLINE (not UNKNOWN) when there were no deliveries', () => {
    expect(webhookStatus({ total: 0, failed: 0 })).toEqual({
      status: 'ONLINE',
      detail: 'No webhook deliveries in the last 24h.',
    });
  });

  it('is DEGRADED when any recent delivery failed', () => {
    expect(webhookStatus({ total: 1204, failed: 3 })).toEqual({
      status: 'DEGRADED',
      detail: '1,204 deliveries in the last 24h, 3 failed.',
    });
  });

  it('is ONLINE when deliveries succeeded', () => {
    expect(webhookStatus({ total: 10, failed: 0 })).toEqual({
      status: 'ONLINE',
      detail: '10 deliveries in the last 24h, none failed.',
    });
  });
});

describe('botStatus', () => {
  it('is UNKNOWN when no cached identity is available', () => {
    expect(botStatus(null)).toEqual({
      status: 'UNKNOWN',
      detail: 'Telegram bot identity is not cached; no live probe performed.',
    });
  });

  it('is ONLINE with a cached identity', () => {
    expect(botStatus({ username: 'botflow_bot' })).toEqual({
      status: 'ONLINE',
      detail: 'Telegram bot identity is cached (getMe succeeded).',
    });
  });
});

describe('withTimeout', () => {
  it('resolves the underlying value when it is fast enough', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'fallback')).resolves.toBe('ok');
  });

  it('falls back when the promise never settles, so a probe cannot hang', async () => {
    const never = new Promise<string>(() => undefined);
    await expect(withTimeout(never, 5, 'fallback')).resolves.toBe('fallback');
  });

  it('propagates a rejection (callers wrap probes in try/catch)', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50, 'fallback')).rejects.toThrow('boom');
  });
});

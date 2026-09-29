import { logger } from '../config/logger';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  onRetry?: (attempt: number, err: unknown) => void;
  /** Return false to stop retrying immediately. */
  shouldRetry?: (err: unknown) => boolean;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 300;
  const max = options.maxDelayMs ?? 10_000;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;

      if (options.shouldRetry && !options.shouldRetry(err)) throw err;
      if (attempt === attempts) break;

      const exp = Math.min(base * 2 ** (attempt - 1), max);
      const delay = options.jitter === false ? exp : Math.round(exp * (0.5 + Math.random() * 0.5));

      logger.debug({ attempt, delay, err: (err as Error)?.message }, 'retrying after failure');
      options.onRetry?.(attempt, err);
      await sleep(delay);
    }
  }

  throw lastErr;
}

/** Retry-After aware backoff for Telegram 429 responses. */
export function telegramRetryAfter(err: unknown): number | null {
  const e = err as { error_code?: number; parameters?: { retry_after?: number } } | undefined;
  if (e?.error_code === 429 && e.parameters?.retry_after) return e.parameters.retry_after;
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Chunk an array into batches — used when fanning out delivery jobs. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

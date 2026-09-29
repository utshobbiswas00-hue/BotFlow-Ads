import type { UserFromGetMe } from 'grammy/types';
import { logger } from '../config/logger';
import { tgApi } from '../utils/telegram';

/**
 * Shared low-level Bot API client.
 *
 * Workers already import `tgApi` from ../utils/telegram directly; this module
 * re-exports it so bot code has a single import site, and adds a cached
 * `getMe()` for places that need the bot's own identity.
 */
export { tgApi };

let cachedSelf: UserFromGetMe | null = null;

/**
 * The bot's own profile, cached for the lifetime of the process.
 * Returns null instead of throwing when the token is missing/invalid so
 * callers can degrade gracefully (e.g. log a warning and skip self-checks).
 */
export async function getBotSelf(): Promise<UserFromGetMe | null> {
  if (cachedSelf) return cachedSelf;

  try {
    cachedSelf = await tgApi.getMe();
    return cachedSelf;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'getBotSelf: getMe failed');
    return null;
  }
}

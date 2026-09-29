import { env } from '../config/env';
import { SETTING_KEYS } from '../config/constants';
import { logger } from '../config/logger';
import { getSetting } from './settings.service';

export type ViewSourceKind = 'mtproto' | 'none';

export interface FetchedViews {
  views: number | null;
  source: 'MTPROTO' | 'NONE';
  reason?: string;
}

export interface PostRef {
  channelTelegramId: bigint;
  telegramMessageId: bigint;
}

/**
 * `mtprotoView.adapter` is an OPTIONAL module that is not present in this
 * repository. It is resolved through a runtime string (not a literal import)
 * so the build never depends on it existing; the service must keep working —
 * with null views — when it is missing.
 */
const MTPROTO_ADAPTER_MODULE = './mtprotoView.adapter' as string;

interface MtprotoAdapter {
  fetchViews: (input: PostRef) => Promise<unknown>;
}

/** Warn about the unconfigured view source only once per process. */
let noViewSourceWarned = false;

function mtprotoCredsConfigured(): boolean {
  return (
    env.TELEGRAM_API_ID.trim() !== '' &&
    env.TELEGRAM_API_HASH.trim() !== '' &&
    env.TELEGRAM_SESSION.trim() !== ''
  );
}

/**
 * Resolves the active view source: 'mtproto' only when the admin has selected
 * it AND the MTProto session env vars are all present; otherwise 'none'.
 */
export async function getViewSource(): Promise<ViewSourceKind> {
  const configured = await getSetting<string>(SETTING_KEYS.VIEW_SOURCE);
  if (configured === 'mtproto' && mtprotoCredsConfigured()) return 'mtproto';
  return 'none';
}

export function isViewMeasurementAvailable(): Promise<boolean> {
  return getViewSource().then((kind) => kind === 'mtproto');
}

/**
 * Fetches the view count for a post, or null when no view source is usable.
 *
 * Contract: NEVER throws, NEVER invents a number. `views: null` is a
 * legitimate, expected outcome — the caller (CPM payout logic) must treat it
 * as "payout paused for this post", not as an error.
 */
export async function fetchPostViews(input: PostRef): Promise<FetchedViews> {
  try {
    const kind = await getViewSource();

    if (kind === 'none') {
      if (!noViewSourceWarned) {
        noViewSourceWarned = true;
        logger.warn(
          'No view source configured (view_source setting is not "mtproto" or the ' +
            'TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION env vars are missing) — ' +
            'views cannot be measured, so CPM payouts cannot be made.',
        );
      }
      return { views: null, source: 'NONE', reason: 'no view source configured' };
    }

    // Optional adapter — absence is expected and handled silently.
    const mod: unknown = await import(MTPROTO_ADAPTER_MODULE).catch(() => null);
    const adapter = (mod as { default?: MtprotoAdapter } | null)?.default;
    if (typeof adapter?.fetchViews !== 'function') {
      logger.debug('MTProto view adapter not available — returning null views');
      return { views: null, source: 'NONE', reason: 'mtproto adapter not available' };
    }

    const raw: unknown = await adapter.fetchViews(input);
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      logger.debug(
        { channelTelegramId: input.channelTelegramId, telegramMessageId: input.telegramMessageId },
        'MTProto adapter returned an invalid views value — treating as null',
      );
      return { views: null, source: 'NONE', reason: 'mtproto adapter returned invalid views' };
    }

    return { views: raw, source: 'MTPROTO' };
  } catch (err) {
    // Never throw: a missing/unusable view source is an expected state, not an error.
    logger.debug({ err }, 'view fetch failed — returning null views');
    return { views: null, source: 'NONE', reason: 'mtproto adapter not available' };
  }
}

export function describeViewSource(kind: ViewSourceKind): string {
  return kind === 'mtproto'
    ? 'Views measured via a Telegram user session'
    : 'View measurement is not configured — CPM payouts are paused';
}

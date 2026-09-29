import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env, isDev } from '../config/env';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { ForbiddenError, InvalidTelegramAuthError, NotFoundError, UnauthorizedError } from '../utils/errors';
import { referralCode } from '../utils/crypto';
import { recordReferral } from '../services/referral.service';
import { trackSession } from '../services/alert.service';
import type { AuthUser } from '../types/auth';

/**
 * Telegram Mini App authentication.
 *
 * Telegram signs `initData` with a key derived from the bot token:
 *   secret_key     = HMAC_SHA256(bot_token, "WebAppData")
 *   data_check_str = sorted "key=value" lines, excluding `hash`
 *   expected_hash  = HMAC_SHA256(data_check_str, secret_key)
 *
 * We recompute it and compare in constant time. Without this check anyone
 * could POST an arbitrary telegramId and drain another user's wallet.
 */

export interface TelegramUserPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

interface ParsedInitData {
  user: TelegramUserPayload;
  authDate: Date;
  queryId?: string;
  startParam?: string;
  raw: Record<string, string>;
}

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60; // reject replays older than 24h

/* ------------------------------------------------------------------
 *  Verification
 * ------------------------------------------------------------------ */

export function verifyInitData(initData: string): ParsedInitData {
  if (!initData) throw new InvalidTelegramAuthError('initData is missing');
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new InvalidTelegramAuthError('Bot token is not configured on the server');
  }
  if (initData.length > 8192) throw new InvalidTelegramAuthError('initData is too large');

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new InvalidTelegramAuthError('initData has no hash');

  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const aBuf = Buffer.from(expected, 'hex');
  const bBuf = Buffer.from(hash, 'hex');
  if (aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) {
    throw new InvalidTelegramAuthError('initData signature does not match');
  }

  // `auth_date` is mandatory and must be a real timestamp: treating a missing
  // value as "now" silently disabled the freshness check entirely.
  const authDateRaw = params.get('auth_date');
  if (!authDateRaw) throw new InvalidTelegramAuthError('initData has no auth_date');
  const authDate = new Date(Number(authDateRaw) * 1000);
  if (!Number.isFinite(authDate.getTime())) {
    throw new InvalidTelegramAuthError('initData has an invalid auth_date');
  }

  const ageSeconds = (Date.now() - authDate.getTime()) / 1000;
  if (ageSeconds > MAX_AUTH_AGE_SECONDS) {
    throw new InvalidTelegramAuthError('initData has expired, please reopen the app');
  }

  const userRaw = params.get('user');
  if (!userRaw) throw new InvalidTelegramAuthError('initData has no user payload');

  let user: TelegramUserPayload;
  try {
    user = JSON.parse(userRaw) as TelegramUserPayload;
  } catch {
    throw new InvalidTelegramAuthError('initData user payload is malformed');
  }

  if (!user?.id || !Number.isFinite(user.id)) {
    throw new InvalidTelegramAuthError('initData user has no valid id');
  }

  return {
    user,
    authDate,
    queryId: params.get('query_id') ?? undefined,
    startParam: params.get('start_param') ?? undefined,
    raw: Object.fromEntries(params.entries()),
  };
}

/**
 * Extract initData from headers or the request body, in that order of trust.
 * NEVER from the query string: initData is a bearer credential, and a URL lands
 * in access logs, proxy logs, browser history and `Referer` headers.
 */
export function extractInitData(req: Request): string | null {
  const header = req.header('x-telegram-init-data');
  if (header) return header;

  const auth = req.header('authorization');
  if (auth?.toLowerCase().startsWith('tma ')) return auth.slice(4).trim();

  const body = req.body as { initData?: string } | undefined;
  if (body?.initData && typeof body.initData === 'string') return body.initData;

  return null;
}

/* ------------------------------------------------------------------
 *  Middleware
 * ------------------------------------------------------------------ */

export interface TelegramAuthOptions {
  /** Create the user + wallet on first sight. */
  autoProvision?: boolean;
  /** Reject users whose status is not ACTIVE. */
  requireActive?: boolean;
}

export function telegramAuth(options: TelegramAuthOptions = {}) {
  const { autoProvision = true, requireActive = true } = options;

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const initData = extractInitData(req);

      // Development escape hatch: allow an explicit telegramId header so the
      // Mini App can be exercised in a normal browser tab. Never in production.
      if (!initData) {
        if (isDev) {
          const devId = req.header('x-dev-telegram-id');
          if (devId && /^\d+$/.test(devId)) {
             const user = await provisionUser(
               { id: Number(devId), first_name: 'Dev', username: `dev${devId.slice(-4)}` },
               autoProvision,
             );
             req.user = user;
             // Fire-and-forget login tracking; never blocks or fails auth.
             trackSession(user.id, req);
             next();
             return;
          }
        }
        throw new UnauthorizedError('Telegram authentication required');
      }

      const parsed = verifyInitData(initData);
      req.initData = initData;

      const user = await provisionUser(parsed.user, autoProvision, parsed.startParam);
      req.user = user;

      // Fire-and-forget login tracking: records the sign-in and raises the
      // new-device security alert if due. It never throws or delays the
      // request — authentication cannot fail because of it.
      trackSession(user.id, req);

      if (requireActive && (user.status === 'BANNED' || user.status === 'SUSPENDED')) {
        throw new ForbiddenError(
          user.status === 'BANNED'
            ? 'Your account has been banned.'
            : 'Your account has been suspended. Please contact support.',
          { status: user.status },
        );
      }

      next();
    } catch (err) {
      // Say WHY. "No initData at all" (the Mini App was opened outside Telegram,
      // or the SDK had not loaded yet) and "signature does not match" (the
      // server's bot token is not the one the app was launched from) look
      // identical on the user's screen, and only one of them is theirs to fix.
      // Neither message carries a secret.
      if (err instanceof InvalidTelegramAuthError) {
        logger.warn({ reason: err.message, path: req.path }, 'telegram auth rejected');
      } else if (err instanceof UnauthorizedError) {
        logger.warn({ reason: 'no initData on the request', path: req.path }, 'telegram auth rejected');
      }
      next(err);
    }
  };
}

/** Attaches the user if credentials are present, but never rejects the request. */
export function optionalTelegramAuth() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const initData = extractInitData(req);
      if (!initData) return next();

      const parsed = verifyInitData(initData);
      req.initData = initData;
      req.user = await provisionUser(parsed.user, true, parsed.startParam);
    } catch (err) {
      logger.debug({ err }, 'optional auth failed, continuing anonymously');
    }
    next();
  };
}

/* ------------------------------------------------------------------
 *  User provisioning
 * ------------------------------------------------------------------ */

async function provisionUser(
  tg: TelegramUserPayload,
  autoProvision: boolean,
  startParam?: string | null,
): Promise<AuthUser> {
  const telegramId = BigInt(tg.id);

  const existing = await prisma.user.findUnique({
    where: { telegramId },
    include: { adminUser: { select: { id: true, role: true, isActive: true } } },
  });

  if (existing) {
    // Refresh profile fields and last-seen; cheap and keeps data current.
    const needsUpdate =
      existing.username !== (tg.username ?? null) ||
      existing.firstName !== (tg.first_name ?? null) ||
      existing.photoUrl !== (tg.photo_url ?? null);

    const user = needsUpdate
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            username: tg.username ?? null,
            firstName: tg.first_name ?? null,
            lastName: tg.last_name ?? null,
            languageCode: tg.language_code ?? null,
            photoUrl: tg.photo_url ?? null,
            isPremium: tg.is_premium ?? false,
            lastSeenAt: new Date(),
          },
        })
      : await prisma.user.update({
          where: { id: existing.id },
          data: { lastSeenAt: new Date() },
        });

    return toAuthUser(user);
  }

  if (!autoProvision) {
    throw new NotFoundError('User', { hint: 'Open the app from Telegram to register' });
  }

  return createUser(tg, startParam);
}

async function createUser(tg: TelegramUserPayload, startParam?: string | null): Promise<AuthUser> {
  const telegramId = BigInt(tg.id);

  // Referral: the Mini App passes ?startapp=ref_XXXX, which Telegram
  // forwards into start_param.
  let referrerId: string | null = null;
  if (startParam?.startsWith('ref_')) {
    const code = startParam.slice(4).toUpperCase();
    const referrer = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } });
    if (referrer) referrerId = referrer.id;
  }

  const user = await prisma.user.create({
    data: {
      telegramId,
      username: tg.username ?? null,
      firstName: tg.first_name ?? null,
      lastName: tg.last_name ?? null,
      languageCode: tg.language_code ?? null,
      photoUrl: tg.photo_url ?? null,
      isPremium: tg.is_premium ?? false,
      referralCode: await uniqueReferralCode(),
      lastSeenAt: new Date(),
      wallet: { create: {} },
      ...(referrerId ? { referredById: referrerId } : {}),
    },
  });

  if (referrerId) {
    // The referral guard (self-referral, multi-account and shared-IP signals)
    // runs here, at the only moment the relationship can be created. A blocked
    // referral writes a FraudEvent instead of a row; a deferred one is still
    // recorded as PENDING so the sweep can pay it once the conditions are met.
    await recordReferral({ referrerId, referredUserId: user.id }).catch((err) =>
      logger.warn({ err, referrerId }, 'could not record referral'),
    );
  }

  logger.info({ userId: user.id, telegramId: String(telegramId) }, 'new user registered');
  return toAuthUser(user);
}

async function uniqueReferralCode(): Promise<string> {
  for (let i = 0; i < 8; i += 1) {
    const code = referralCode(8);
    const clash = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } });
    if (!clash) return code;
  }
  return referralCode(12);
}

function toAuthUser(u: {
  id: string;
  telegramId: bigint;
  username: string | null;
  status: string;
  isAdvertiser: boolean;
  isPublisher: boolean;
}): AuthUser {
  return {
    id: u.id,
    telegramId: u.telegramId.toString(),
    username: u.username,
    status: u.status,
    isAdvertiser: u.isAdvertiser,
    isPublisher: u.isPublisher,
  };
}

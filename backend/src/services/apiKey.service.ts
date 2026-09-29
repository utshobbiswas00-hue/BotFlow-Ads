import crypto from 'node:crypto';
import { Prisma, type AdvertiserApiKey } from '@prisma/client';
import { createApiKeySchema, type ApiKeyScope } from '@botflow/shared';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors';
import { recordAudit } from './audit.service';

/**
 * Advertiser programmatic access — API keys.
 *
 * Security model:
 *   - A key is `bfa_live_<random>`. The random part is 32 cryptographically
 *     random bytes (base64url). Only its SHA-256 hash and its first 12
 *     characters (the display prefix) are stored. There is NO code path that
 *     re-reads the plaintext — it exists only in the creation response.
 *   - Lookup is by prefix (unique, cheap), then the presented key is hashed
 *     and compared in constant time.
 *   - Keys are revoked (revokedAt), never deleted, so conversions and
 *     campaigns they created stay attributable.
 */

const KEY_PREFIX = 'bfa_live_';
/** Display prefix length — first chars of the RANDOM part, not of KEY_PREFIX. */
const DISPLAY_PREFIX_LENGTH = 12;

export interface CreateApiKeyInput {
  label: string;
  scopes: Array<'READ' | 'WRITE'>;
  /** Optional expiry, in days from now. Omitted = never expires. */
  expiresInDays?: number;
}

/** A key row without the secret material — safe to serialize anywhere. */
export interface ApiKeyView {
  id: string;
  label: string;
  prefix: string;
  scopes: ApiKeyScope[];
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  /** True when revokedAt is set. */
  revoked: boolean;
  /** True when the key has an expiry and it is in the past. */
  expired: boolean;
  createdAt: Date;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomPart(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function toView(row: AdvertiserApiKey): ApiKeyView {
  const now = Date.now();
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    scopes: row.scopes as unknown as ApiKeyScope[],
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revoked: row.revokedAt !== null,
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
    createdAt: row.createdAt,
  };
}

/**
 * Issue a new API key for a user.
 *
 * Returns the plaintext key ONCE. The database keeps only the hash, so after
 * this response the key can never be shown again — a lost key must be revoked
 * and re-issued.
 */
export async function createApiKey(
  userId: string,
  input: CreateApiKeyInput,
): Promise<{ key: string; record: ApiKeyView }> {
  const parsed = createApiKeySchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('Invalid API key request', parsed.error.issues);
  }
  const { label, scopes, expiresInDays } = parsed.data;

  // Unique scopes, in a stable order.
  const uniqueScopes = [...new Set(scopes)] as ApiKeyScope[];
  const expiresAt =
    expiresInDays !== undefined ? new Date(Date.now() + expiresInDays * 86_400_000) : null;

  // The prefix is unique; regenerate on the (astronomically unlikely) collision.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const secret = randomPart();
    const key = `${KEY_PREFIX}${secret}`;
    try {
      const row = await prisma.advertiserApiKey.create({
        data: {
          userId,
          label,
          prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH),
          keyHash: sha256Hex(key),
          scopes: uniqueScopes,
          expiresAt,
        },
      });

      await recordAudit({
        actorId: userId,
        actorType: 'USER',
        action: 'API_KEY_CREATED',
        targetType: 'ADVERTISER_API_KEY',
        targetId: row.id,
        newValue: { label, scopes: uniqueScopes, expiresAt },
        // Deliberately no key material — not even the full prefix of the secret.
      });

      return { key, record: toView(row) };
    } catch (err) {
      const isUniqueConflict =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      if (!isUniqueConflict) throw err;
      lastError = err;
    }
  }
  logger.error({ err: lastError, userId }, 'failed to allocate a unique API key prefix');
  throw lastError instanceof Error ? lastError : new Error('Failed to create API key');
}

/** List a user's keys. Never includes keyHash — the secret is unrecoverable. */
export async function listApiKeys(userId: string): Promise<ApiKeyView[]> {
  const rows = await prisma.advertiserApiKey.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toView);
}

/**
 * Revoke a key. Idempotent: revoking an already-revoked key is a no-op.
 * Returns 404 (not 403) for keys that belong to someone else, so one
 * account cannot probe another account's key ids.
 */
export async function revokeApiKey(userId: string, id: string): Promise<ApiKeyView> {
  const existing = await prisma.advertiserApiKey.findUnique({ where: { id } });
  if (!existing || existing.userId !== userId) {
    throw new NotFoundError('API key');
  }
  if (existing.revokedAt) {
    return toView(existing);
  }

  const updated = await prisma.advertiserApiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  await recordAudit({
    actorId: userId,
    actorType: 'USER',
    action: 'API_KEY_REVOKED',
    targetType: 'ADVERTISER_API_KEY',
    targetId: id,
    oldValue: { revokedAt: null },
    newValue: { revokedAt: updated.revokedAt },
  });

  return toView(updated);
}

/**
 * Authenticate a presented key and return the (hash-free) row on success.
 *
 * Throws UnauthorizedError with a distinct, plain-language message for:
 *   - missing/invalid format        → the key cannot be a valid key
 *   - unknown prefix or wrong secret → "Invalid API key" (no hint which one)
 *   - revoked                        → "revoked"
 *   - expired                        → "expired"
 *
 * On success stamps lastUsedAt / lastUsedIp (best effort — a stamp failure
 * must not break an otherwise-valid request).
 */
export async function resolveApiKey(presented: string, ip?: string | null): Promise<AdvertiserApiKey> {
  if (typeof presented !== 'string' || !presented.startsWith(KEY_PREFIX)) {
    throw new UnauthorizedError('Invalid API key. Keys look like "bfa_live_…" and are sent as "Authorization: Bearer <key>".');
  }

  const secret = presented.slice(KEY_PREFIX.length);
  if (secret.length < 20 || secret.length > 128) {
    throw new UnauthorizedError('Invalid API key format.');
  }

  const row = await prisma.advertiserApiKey.findUnique({
    where: { prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH) },
  });
  if (!row) {
    // Same message as a wrong secret — never reveal which prefixes exist.
    throw new UnauthorizedError('Invalid API key.');
  }

  // Constant-time compare of the SHA-256 of the presented key against the
  // stored hash. Both digests are always 32 bytes, so the length check is a
  // no-op safety net, not a timing channel.
  const presentedHash = Buffer.from(sha256Hex(presented), 'hex');
  const storedHash = Buffer.from(row.keyHash, 'hex');
  if (presentedHash.length !== storedHash.length || !crypto.timingSafeEqual(presentedHash, storedHash)) {
    throw new UnauthorizedError('Invalid API key.');
  }

  if (row.revokedAt) {
    throw new UnauthorizedError('This API key has been revoked. Create a new key from your BotFlow profile.');
  }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw new UnauthorizedError('This API key has expired. Create a new key from your BotFlow profile.');
  }

  try {
    await prisma.advertiserApiKey.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date(), lastUsedIp: ip ?? null },
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, apiKeyId: row.id }, 'failed to stamp lastUsedAt');
  }

  return row;
}

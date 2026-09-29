import crypto from 'node:crypto';
import { env } from '../config/env';

const ALGO = 'aes-256-gcm';

/* ------------------------------------------------------------------
 *  Hashing
 * ------------------------------------------------------------------ */

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Hash an IP so we can detect duplicate clicks without storing PII.
 * Salted with JWT_SECRET so the hashes are not reversible via rainbow tables.
 */
export function hashIp(ip: string): string {
  return sha256(`${ip}:${env.JWT_SECRET}`).slice(0, 32);
}

export function hashUserAgent(ua: string): string {
  return sha256(ua).slice(0, 32);
}

export function hmacSha256(payload: string, secret: string): Buffer {
  return crypto.createHmac('sha256', secret).update(payload).digest();
}

export function timingSafeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------
 *  Random
 * ------------------------------------------------------------------ */

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomDigits(length = 6): string {
  let out = '';
  while (out.length < length) out += crypto.randomInt(0, 10).toString();
  return out;
}

/** URL-safe slug used for click-tracking links: /c/:slug */
export function trackingSlug(prefix = 'ad'): string {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1

export function referralCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += REF_ALPHABET[crypto.randomInt(0, REF_ALPHABET.length)];
  }
  return out;
}

export function ticketNumber(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `MTX-${stamp}-${randomDigits(5)}`;
}

/* ------------------------------------------------------------------
 *  Symmetric encryption — for withdrawal account details at rest
 * ------------------------------------------------------------------ */

function key(): Buffer {
  const raw = env.ENCRYPTION_KEY;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decrypt(payload: string): string {
  const [ivPart, tagPart, dataPart] = payload.split('.');
  if (!ivPart || !tagPart || !dataPart) throw new Error('decrypt: malformed payload');
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T>(payload: string): T {
  return JSON.parse(decrypt(payload)) as T;
}

/** Mask an account number for display: 01712345678 -> 0171****678 */
export function maskAccount(value: string): string {
  const clean = value.trim();
  if (clean.length <= 6) return '****';
  const head = clean.slice(0, 4);
  const tail = clean.slice(-3);
  return `${head}${'*'.repeat(Math.max(3, clean.length - 7))}${tail}`;
}

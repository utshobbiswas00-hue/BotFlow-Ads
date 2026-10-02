import crypto from 'node:crypto';

/**
 * Password hashing for the staff panel login.
 *
 * scrypt, from Node's own crypto module — no new dependency, and scrypt is
 * memory-hard, so a GPU farm gains far less against it than against a plain
 * SHA-256 (or an unsalted MD5, which is what a "simple" admin login usually
 * ships with).
 *
 * Stored format (one line, self-describing so the parameters can be raised later
 * without invalidating existing hashes):
 *
 *   scrypt$<N>$<r>$<p>$<saltHex>$<keyHex>
 *
 * The comparison is `timingSafeEqual`, so the hash cannot be recovered a byte at
 * a time by measuring how long the check takes.
 */

const N = 16384; // CPU/memory cost (2^14)
const R = 8; // block size
const P = 1; // parallelisation
const KEY_LEN = 64;
const SALT_BYTES = 16;

// scrypt needs maxmem raised above its 32 MB default at these parameters.
const MAX_MEM = 64 * 1024 * 1024;

export const PASSWORD_HASH_PREFIX = 'scrypt';

export function hashPassword(plain: string): string {
  if (!plain) throw new Error('Cannot hash an empty password');
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = crypto.scryptSync(plain, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM });
  return `${PASSWORD_HASH_PREFIX}$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false — never throws — for a malformed or empty hash, so a
 * misconfigured deployment fails closed (nobody gets in) rather than open.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  if (!plain || !stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PASSWORD_HASH_PREFIX) return false;

  const n = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = crypto.scryptSync(plain, salt, expected.length, { N: n, r, p, maxmem: MAX_MEM });
  } catch {
    return false;
  }

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Compare two short secrets in constant time (usernames, tokens).
 * Length differences leak, which is acceptable for an identifier that is not a
 * secret in itself.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

import { describe, expect, it } from 'vitest';
import { hashPassword, safeEqual, verifyPassword } from '../password';

/**
 * The password check is the only thing standing between the internet and every
 * financial control in the product, so its failure modes are pinned here rather
 * than assumed.
 *
 * The property that matters most: a MISSING or MALFORMED stored hash must fail
 * closed. A deployment with `ADMIN_PANEL_PASSWORD_HASH` set to garbage must lock
 * everyone out, not let everyone in.
 */
describe('hashPassword / verifyPassword', () => {
  it('round-trips the correct password', () => {
    const stored = hashPassword('a-test-password');
    expect(verifyPassword('a-test-password', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('a-test-password');
    expect(verifyPassword('Admin124', stored)).toBe(false);
    expect(verifyPassword('admin123', stored)).toBe(false);
    expect(verifyPassword('a-test-password ', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('produces a different hash every time (random salt)', () => {
    const a = hashPassword('a-test-password');
    const b = hashPassword('a-test-password');
    expect(a).not.toBe(b);
    // …and both still verify, which is the point of storing the salt inline.
    expect(verifyPassword('a-test-password', a)).toBe(true);
    expect(verifyPassword('a-test-password', b)).toBe(true);
  });

  it('stores the parameters alongside the digest so they can be raised later', () => {
    const stored = hashPassword('a-test-password');
    const [scheme, n, r, p, salt, key] = stored.split('$');
    expect(scheme).toBe('scrypt');
    expect(n).toBe('16384');
    expect(r).toBe('8');
    expect(p).toBe('1');
    expect(salt).toMatch(/^[0-9a-f]{32}$/); // 16 random bytes
    expect(key).toMatch(/^[0-9a-f]{128}$/); // 64-byte derived key
  });

  it('never embeds the plaintext', () => {
    expect(hashPassword('a-test-password')).not.toContain('a-test-password');
  });

  it('refuses to hash an empty password', () => {
    expect(() => hashPassword('')).toThrow();
  });

  it('fails closed on a missing or malformed stored hash', () => {
    // Every one of these is a misconfiguration, and every one must deny access
    // rather than accidentally allow it.
    const bad = [
      '',
      'not-a-hash',
      'scrypt$16384$8$1$deadbeef', // too few segments
      'scrypt$16384$8$1$$', // empty salt and key
      'bcrypt$16384$8$1$aabb$ccdd', // wrong scheme
      'scrypt$abc$8$1$aabb$ccdd', // non-numeric cost
      'scrypt$16384$8$1$zz$zz', // non-hex
      'a-test-password', // a plaintext password left in the config
    ];
    for (const stored of bad) {
      expect(verifyPassword('a-test-password', stored)).toBe(false);
    }
  });
});

describe('safeEqual', () => {
  it('matches equal strings and rejects different ones', () => {
    expect(safeEqual('same-value', 'same-value')).toBe(true);
    expect(safeEqual('same-value', 'other-value')).toBe(false);
    expect(safeEqual('same-value', 'same-value-x')).toBe(false); // length differs
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('a', '')).toBe(false);
  });
});

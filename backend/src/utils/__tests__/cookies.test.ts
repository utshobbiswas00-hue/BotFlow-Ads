import { describe, expect, it } from 'vitest';
import { clearCookie, readCookie, serializeCookie } from '../cookies';

/**
 * Cookie parsing and serialising is hand-rolled, which means these are the tests
 * standing between a parsing bug and an authentication bypass. A `readCookie`
 * that returns the wrong value for a crafted header is not a cosmetic problem.
 */
describe('readCookie', () => {
  it('finds a cookie among others', () => {
    const header = 'a=1; bf_admin_sid=abc123; z=9';
    expect(readCookie(header, 'bf_admin_sid')).toBe('abc123');
    expect(readCookie(header, 'a')).toBe('1');
    expect(readCookie(header, 'z')).toBe('9');
  });

  it('handles spacing, missing spaces and a trailing semicolon', () => {
    expect(readCookie('bf_admin_sid=abc', 'bf_admin_sid')).toBe('abc');
    expect(readCookie('  bf_admin_sid=abc  ', 'bf_admin_sid')).toBe('abc');
    expect(readCookie('a=1;bf_admin_sid=abc;', 'bf_admin_sid')).toBe('abc');
    expect(readCookie('a=1; bf_admin_sid=abc ; b=2', 'bf_admin_sid')).toBe('abc');
  });

  it('returns null for a missing cookie or a missing header', () => {
    expect(readCookie(undefined, 'bf_admin_sid')).toBeNull();
    expect(readCookie('', 'bf_admin_sid')).toBeNull();
    expect(readCookie('other=1', 'bf_admin_sid')).toBeNull();
  });

  it('returns null for an empty value', () => {
    expect(readCookie('bf_admin_sid=', 'bf_admin_sid')).toBeNull();
    expect(readCookie('bf_admin_sid=; a=1', 'bf_admin_sid')).toBeNull();
  });

  it('does not match a cookie whose name merely contains the target', () => {
    // Substring matching would let an attacker plant `xbf_admin_sid=...` and have
    // it read as the session cookie.
    expect(readCookie('xbf_admin_sid=evil', 'bf_admin_sid')).toBeNull();
    expect(readCookie('bf_admin_sid_extra=evil', 'bf_admin_sid')).toBeNull();
  });

  it('keeps "=" characters inside the value (base64url padding included)', () => {
    expect(readCookie('bf_admin_sid=aa==bb.cc-dd', 'bf_admin_sid')).toBe('aa==bb.cc-dd');
  });

  it('decodes percent-encoding but refuses a malformed escape', () => {
    expect(readCookie('bf_admin_sid=a%20b', 'bf_admin_sid')).toBe('a b');
    // "%zz" is not a valid escape; treating it as a literal would mean two
    // different strings parse to the same value.
    expect(readCookie('bf_admin_sid=%zz', 'bf_admin_sid')).toBeNull();
  });

  it('ignores segments without a name', () => {
    expect(readCookie(';=; bf_admin_sid=abc', 'bf_admin_sid')).toBe('abc');
  });
});

describe('serializeCookie', () => {
  const base = { maxAge: 3600, httpOnly: true, secure: true, sameSite: 'Strict' as const, path: '/' };

  it('includes every attribute that matters', () => {
    const out = serializeCookie('bf_admin_sid', 'abc', base);
    expect(out).toContain('bf_admin_sid=abc');
    expect(out).toContain('Path=/');
    expect(out).toContain('Max-Age=3600');
    expect(out).toContain('SameSite=Strict');
    expect(out).toContain('HttpOnly');
    expect(out).toContain('Secure');
  });

  it('omits HttpOnly only when asked (the CSRF cookie must be JS-readable)', () => {
    const out = serializeCookie('bf_admin_csrf', 'abc', { ...base, httpOnly: false });
    expect(out).not.toContain('HttpOnly');
  });

  it('omits Secure in development', () => {
    expect(serializeCookie('c', 'v', { ...base, secure: false })).not.toContain('Secure');
  });

  it('round-trips through readCookie', () => {
    const header = serializeCookie('bf_admin_sid', 'aa==bb.cc-dd', base).split(';')[0];
    expect(readCookie(header, 'bf_admin_sid')).toBe('aa==bb.cc-dd');
  });

  it('never emits a negative Max-Age', () => {
    expect(serializeCookie('c', 'v', { ...base, maxAge: -5 })).toContain('Max-Age=0');
  });
});

describe('clearCookie', () => {
  it('expires the cookie immediately', () => {
    const out = clearCookie('bf_admin_sid', { path: '/', secure: true, sameSite: 'Strict' });
    expect(out).toContain('Max-Age=0');
    expect(out).toContain('bf_admin_sid=');
    expect(out).toContain('HttpOnly');
  });
});

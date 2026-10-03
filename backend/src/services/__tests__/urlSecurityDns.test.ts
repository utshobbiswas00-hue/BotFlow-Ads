import { describe, expect, it, vi } from 'vitest';

/**
 * The DNS half of the SSRF guard.
 *
 * `isPrivateOrInternalHost` judges the HOSTNAME, and a public name that resolves into the
 * private network passes it: `https://attacker.example` → 10.0.0.5 was accepted, and the
 * outbound request then reached an internal service. These tests cover the check that runs
 * on the resolved addresses instead, and the lookup that pins the vetted answers to the
 * request so a nameserver cannot change its mind between the check and the connection.
 *
 * No database is touched; the module only needs its Prisma/Redis imports satisfied.
 */
vi.mock('../../db/prisma', () => ({ prisma: {}, transaction: vi.fn() }));
vi.mock('../../db/redis', () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }));
vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { isPrivateOrInternalHost, pinnedLookup, resolveHostAddresses } from '../urlSecurity.service';

describe('addresses that must never be dialled', () => {
  it.each([
    ['localhost', 'the name itself'],
    ['127.0.0.1', 'IPv4 loopback'],
    ['10.1.2.3', 'RFC1918 10/8'],
    ['172.16.0.9', 'RFC1918 172.16/12'],
    ['192.168.1.1', 'RFC1918 192.168/16'],
    ['169.254.169.254', 'link-local, the cloud metadata service'],
    ['100.64.0.1', 'CGNAT'],
    ['0.0.0.0', 'unspecified'],
    ['::1', 'IPv6 loopback'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd00::1', 'IPv6 unique-local'],
    ['::ffff:10.0.0.1', 'IPv4-mapped IPv6'],
  ])('refuses %s (%s)', async (host) => {
    const result = await resolveHostAddresses(host);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('internal');
  });
});

describe('addresses that are fine to dial', () => {
  it('accepts a public IP literal without a lookup', async () => {
    const result = await resolveHostAddresses('8.8.8.8');
    expect(result).toEqual({ ok: true, addresses: ['8.8.8.8'] });
  });

  it('accepts a public IPv6 literal', async () => {
    const result = await resolveHostAddresses('2606:4700::1111');
    expect(result).toEqual({ ok: true, addresses: ['2606:4700::1111'] });
  });
});

describe('a name that cannot be resolved', () => {
  it('is reported as unresolved, NOT as internal', async () => {
    // The distinction matters: unresolvable is "unverifiable" and must never hard-block an
    // advertiser whose DNS is briefly broken, while resolving inward is a refusal.
    const result = await resolveHostAddresses('definitely-not-a-registered-name.invalid');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unresolved');
  });

  it('is unresolved for an empty host too', async () => {
    const result = await resolveHostAddresses('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unresolved');
  });
});

describe('the pinned lookup', () => {
  it('answers with a vetted address and its family', () => {
    const cb = vi.fn();
    pinnedLookup(['93.184.216.34'])('example.com', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('reports IPv6 as family 6', () => {
    const cb = vi.fn();
    pinnedLookup(['2606:4700::1111'])('example.com', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '2606:4700::1111', 6);
  });

  it('returns the whole vetted set when the caller asked for all', () => {
    const cb = vi.fn();
    pinnedLookup(['93.184.216.34', '2606:4700::1111'])('example.com', { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);
  });

  it('fails rather than connecting when nothing was vetted', () => {
    // Never silently fall through to the resolver: an empty pin means the request must not
    // happen at all.
    const cb = vi.fn();
    pinnedLookup([])('example.com', {}, cb);
    expect(cb.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

describe('the existing literal check still stands on its own', () => {
  it('flags loopback and private literals', () => {
    expect(isPrivateOrInternalHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrInternalHost('192.168.0.1')).toBe(true);
    expect(isPrivateOrInternalHost('example.com')).toBe(false);
  });
});

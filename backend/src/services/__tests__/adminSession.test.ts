import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Server-side session store.
 *
 * `db/redis` is mocked with a client that is NOT `ready`, which puts the service
 * on its in-process fallback path. That is deterministic and, more importantly,
 * it exercises the code that runs during a Redis outage — the path most likely to
 * be wrong, because it is the one nobody watches in production.
 *
 * The invariant these tests protect: a session that cannot be found must read as
 * absent, never as "authenticated". Fail-open here would be a total bypass.
 */
vi.mock('../../db/redis', () => ({
  redis: { status: 'end' },
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}));

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.JWT_SECRET = 'test-secret-do-not-use';
});

let svc: typeof import('../adminSession.service');

beforeEach(async () => {
  vi.resetModules();
  svc = await import('../adminSession.service');
  svc.__resetMemorySessionsForTest();
});

async function makeSession(adminId = 'adm_1') {
  return svc.createSession({ adminId, ip: '203.0.113.9', userAgent: 'vitest' });
}

describe('createSession / readSession', () => {
  it('creates a session that reads back with the same admin and csrf', async () => {
    const created = await makeSession();
    const record = await svc.readSession(created.sid);

    expect(record).not.toBeNull();
    expect(record?.adminId).toBe('adm_1');
    expect(record?.csrf).toBe(created.csrf);
    expect(record?.ip).toBe('203.0.113.9');
  });

  it('issues a high-entropy id and csrf, and they are different values', async () => {
    const a = await makeSession();
    const b = await makeSession();

    // 32 random bytes → 43 base64url characters.
    expect(a.sid.length).toBeGreaterThanOrEqual(42);
    expect(a.csrf.length).toBeGreaterThanOrEqual(42);
    expect(a.sid).not.toBe(a.csrf);
    // Two sessions must never collide.
    expect(a.sid).not.toBe(b.sid);
    expect(a.csrf).not.toBe(b.csrf);
  });

  it('returns null for an unknown session id', async () => {
    await makeSession();
    expect(await svc.readSession('not-a-real-session')).toBeNull();
  });

  it('returns null for an empty session id', async () => {
    expect(await svc.readSession('')).toBeNull();
  });

  it('does not accept one session id in place of another', async () => {
    const a = await makeSession('adm_1');
    const b = await makeSession('adm_2');

    expect((await svc.readSession(a.sid))?.adminId).toBe('adm_1');
    expect((await svc.readSession(b.sid))?.adminId).toBe('adm_2');
    // A truncated or mutated id must not resolve.
    expect(await svc.readSession(a.sid.slice(0, -1))).toBeNull();
    expect(await svc.readSession(`${a.sid}x`)).toBeNull();
  });

  it('reports an expiry in the future and a TTL', async () => {
    const created = await makeSession();
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(created.ttlSeconds).toBeGreaterThan(60);
  });
});

describe('destroySession', () => {
  it('makes the session unreadable', async () => {
    const created = await makeSession();
    expect(await svc.readSession(created.sid)).not.toBeNull();

    await svc.destroySession(created.sid);
    expect(await svc.readSession(created.sid)).toBeNull();
  });

  it('tolerates an unknown or empty id', async () => {
    await expect(svc.destroySession('nope')).resolves.toBeUndefined();
    await expect(svc.destroySession('')).resolves.toBeUndefined();
  });

  it('leaves other sessions of the same admin alone (sign out one device)', async () => {
    const first = await makeSession('adm_1');
    const second = await makeSession('adm_1');

    await svc.destroySession(first.sid);

    expect(await svc.readSession(first.sid)).toBeNull();
    expect(await svc.readSession(second.sid)).not.toBeNull();
  });
});

describe('listSessions', () => {
  it('lists only the given admin, newest first, with a short fingerprint', async () => {
    await makeSession('adm_1');
    await makeSession('adm_2');
    const mine = await makeSession('adm_1');

    const sessions = await svc.listSessions('adm_1');
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.fingerprint).toHaveLength(12);
      expect(s.userAgent).toBe('vitest');
    }
    // Newest first.
    expect(sessions[0].createdAt >= sessions[1].createdAt).toBe(true);
    // The fingerprint is a slice of a hash — it must not be the session id.
    expect(sessions.map((s) => s.fingerprint)).not.toContain(mine.sid);
  });

  it('returns an empty list for an admin with no sessions', async () => {
    expect(await svc.listSessions('adm_nobody')).toEqual([]);
  });
});

describe('destroyAllSessions', () => {
  it('revokes every session of one admin and nobody else', async () => {
    const a1 = await makeSession('adm_1');
    const a2 = await makeSession('adm_1');
    const b1 = await makeSession('adm_2');

    const revoked = await svc.destroyAllSessions('adm_1');
    expect(revoked).toBe(2);

    expect(await svc.readSession(a1.sid)).toBeNull();
    expect(await svc.readSession(a2.sid)).toBeNull();
    // Another admin's session is untouched — "sign out everywhere" must not be
    // "sign out everyone".
    expect(await svc.readSession(b1.sid)).not.toBeNull();
  });
});

describe('csrfMatches', () => {
  it('accepts only an exact, constant-length match', () => {
    expect(svc.csrfMatches('token-value', 'token-value')).toBe(true);
    expect(svc.csrfMatches('token-value', 'token-valuf')).toBe(false);
    expect(svc.csrfMatches('token-value', 'token-value ')).toBe(false);
    expect(svc.csrfMatches('token-value', 'token-valu')).toBe(false);
  });

  it('rejects empty values on either side', () => {
    // An empty expected value must never match an empty provided one: that would
    // make a session with no CSRF token accept requests with no header.
    expect(svc.csrfMatches('', '')).toBe(false);
    expect(svc.csrfMatches('token', '')).toBe(false);
    expect(svc.csrfMatches('', 'token')).toBe(false);
  });
});

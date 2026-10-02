/**
 * The panel must be reachable from a browser, not only from inside Telegram.
 *
 * This is the test that was missing, and its absence is why a real bug shipped.
 * Every other panel test mounts its router onto a bare Express app, so all of them
 * passed while the assembled application had the entire `/api/admin` tree mounted
 * *inside* the `/api` router — behind `telegramAuth()`, which demands Telegram
 * initData. A browser holding only a username and a password could not reach
 * `GET /api/admin/auth/config` or `POST /api/admin/auth/login`: both were answered
 * `401 Telegram authentication required` before any panel route ran, and the login
 * page showed that message as a field error with the button dead.
 *
 * The routes were individually correct. Their *position* was not — the same trap
 * `publicApiRouter` is deliberately mounted above the user router to avoid.
 *
 * So these assertions are about ORDER, and they run against the app the way
 * `createApp()` actually assembles it, over real HTTP.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/app';

/** The message `telegramAuth` throws — the one a browser must never see on a panel route. */
const TELEGRAM_ONLY = 'Telegram authentication required';

let server: Server;
let origin: string;

async function req(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: { error?: { message?: string }; data?: unknown } }> {
  const res = await fetch(`${origin}${path}`, init);
  const text = await res.text();
  let body: never | Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body: body as never };
}

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    // Port 0: the OS picks a free one, so this cannot collide with a running dev server.
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the panel is reachable without Telegram initData', () => {
  it('answers GET /api/admin/auth/config for a plain browser', async () => {
    const { status, body } = await req('/api/admin/auth/config');

    // Before the fix this was 401 with the telegram message, which is what the login
    // page rendered — making the password door look broken while it was merely hidden.
    expect(body.error?.message).not.toBe(TELEGRAM_ONLY);
    expect(status).toBe(200);
    expect(body.data).toHaveProperty('passwordLoginEnabled');
  });

  it('lets a login POST reach the panel rather than the Telegram gate', async () => {
    const { status, body } = await req('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'nothing-at-all' }),
    });

    // Reaching the panel's own CSRF guard is the point: it means the request got past
    // the mount point. 401 + the telegram message means it did not.
    expect(body.error?.message).not.toBe(TELEGRAM_ONLY);
    expect(status).not.toBe(401);
    expect(status).toBe(403);
  });

  it('answers a stale panel cookie in the panel’s own words', async () => {
    const { status, body } = await req('/api/admin/session', {
      headers: { Cookie: 'bf_admin_sid=deadbeefdeadbeefdeadbeef' },
    });

    // The panel's cookie door is evaluated at the panel, so a cookie it does not
    // recognise is answered by the panel ("session has expired"), not by the
    // Telegram gate. Getting the Telegram message here would mean the cookie door is
    // again running somewhere that cannot see it.
    expect(status).toBe(401);
    expect(body.error?.message).not.toBe(TELEGRAM_ONLY);
    expect(body.error?.message).toMatch(/session/i);

    // Deliberately NOT asserted: with no cookie at all this endpoint answers with the
    // Telegram message. That is the documented hand-off — the panel offers two doors,
    // and presenting neither leaves the Telegram one to explain itself. It is why the
    // assertion above needs a cookie to be meaningful.
  });
});

describe('the user-facing API is still guarded by Telegram', () => {
  it('keeps rejecting /api/me without initData', async () => {
    const { status, body } = await req('/api/me');

    // The fix moved the panel out of the telegramAuth scope; the user surface must not
    // have moved with it.
    expect(status).toBe(401);
    expect(body.error?.message).toBe(TELEGRAM_ONLY);
  });
});

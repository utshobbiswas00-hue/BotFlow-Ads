import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Telegram SDK is not guaranteed to exist when the bundle first runs: the
 * native client injects `window.Telegram.WebApp`, and index.html also fetches
 * it as a script. Reading it once at startup meant an app that lost that race
 * stayed signed out for the whole session — every request carried an empty
 * `x-telegram-init-data` and the server answered 401, which the UI renders as
 * "You are not signed in. Reopen the app from the Telegram bot to log in
 * again." — advice that cannot help, because "Try again" rebuilt the header
 * from the same null snapshot.
 *
 * Each case re-imports the module so the one-shot readiness wait is fresh.
 */
async function freshTelegram() {
  vi.resetModules();
  return await import('../lib/telegram');
}

function fakeSdk(initData: string) {
  return {
    initData,
    ready: vi.fn(),
    expand: vi.fn(),
    onEvent: vi.fn(),
    themeParams: {},
    setHeaderColor: vi.fn(),
    setBackgroundColor: vi.fn(),
    colorScheme: 'dark' as const,
  };
}

function attach(sdk: ReturnType<typeof fakeSdk> | null): void {
  const w = window as unknown as { Telegram?: unknown };
  if (sdk) w.Telegram = { WebApp: sdk };
  else delete w.Telegram;
}

afterEach(() => {
  attach(null);
});

describe('Telegram SDK discovery', () => {
  it('reports no initData while the SDK is absent', async () => {
    const { getInitData, isTelegram } = await freshTelegram();
    attach(null);

    expect(getInitData()).toBe('');
    expect(isTelegram()).toBe(false);
  });

  it('picks up an SDK that appears AFTER the bundle ran', async () => {
    const { getInitData, isTelegram } = await freshTelegram();
    attach(null);
    // Startup read: nothing there yet.
    expect(getInitData()).toBe('');

    // The client injects it a beat later.
    attach(fakeSdk('user=%7B%22id%22%3A1%7D&hash=abc'));

    expect(getInitData()).toBe('user=%7B%22id%22%3A1%7D&hash=abc');
    expect(isTelegram()).toBe(true);
  });

  it('resolves whenTelegramReady once a late SDK arrives', async () => {
    const { whenTelegramReady, getInitData } = await freshTelegram();
    attach(null);

    const ready = whenTelegramReady(1_000);
    setTimeout(() => attach(fakeSdk('late=1')), 150);

    await expect(ready).resolves.toBeUndefined();
    expect(getInitData()).toBe('late=1');
  });

  it('does not hang when the SDK never arrives (a plain browser)', async () => {
    const { whenTelegramReady, getInitData } = await freshTelegram();
    attach(null);

    await expect(whenTelegramReady(200)).resolves.toBeUndefined();
    expect(getInitData()).toBe('');
  });
});

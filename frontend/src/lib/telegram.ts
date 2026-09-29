import type { TelegramThemeParams, TelegramWebApp } from '../vite-env';
import '../mono-theme.css';

let webApp: TelegramWebApp | null = null;
let ready: Promise<void> | null = null;

/**
 * Read the SDK live, never from a snapshot.
 *
 * `window.Telegram.WebApp` is injected by the native client and ALSO fetched as
 * a script, so it is not always there the instant the bundle runs. Capturing it
 * once at startup meant an app that lost that race stayed signed out for the
 * whole session: every request carried an empty `x-telegram-init-data`, and
 * "Try again" could never help because the header was still built from the same
 * null snapshot.
 */
function sdk(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when running inside the Telegram client WebView. */
export function isTelegram(): boolean {
  return sdk() !== null || webApp !== null;
}

/** Raw initData string sent on every API request. */
export function getInitData(): string {
  return sdk()?.initData ?? webApp?.initData ?? '';
}

/**
 * Resolve once the Telegram SDK is available, or once the wait is over.
 *
 * The wait happens at most once per page load: afterwards this resolves
 * immediately, and `getInitData()` still reads the SDK live, so a still-later
 * SDK is picked up by the next request rather than costing every request a
 * delay (outside Telegram there is never an SDK, and nothing may hang on it).
 */
export function whenTelegramReady(timeoutMs = 5_000): Promise<void> {
  const now = sdk();
  if (now) {
    wire(now);
    return Promise.resolve();
  }
  if (!ready) {
    ready = (async () => {
      const deadline = Date.now() + timeoutMs;
      while (!sdk() && Date.now() < deadline) await sleep(100);
      const tg = sdk();
      if (tg) wire(tg);
    })();
  }
  return ready;
}

/** Map Telegram themeParams onto our CSS variables (with light fallbacks in CSS). */
function applyThemeParams(params: TelegramThemeParams | undefined): void {
  if (!params) return;
  const root = document.documentElement;
  const map: Array<[string, string | undefined]> = [
    ['--tg-theme-bg-color', params.bg_color],
    ['--tg-theme-text-color', params.text_color],
    ['--tg-theme-hint-color', params.hint_color],
    ['--tg-theme-link-color', params.link_color],
    ['--tg-theme-button-color', params.button_color],
    ['--tg-theme-button-text-color', params.button_text_color],
    ['--tg-theme-secondary-bg-color', params.secondary_bg_color],
    ['--tg-theme-section-bg-color', params.section_bg_color],
    ['--tg-theme-section-header-text-color', params.section_header_text_color],
    ['--tg-theme-subtitle-text-color', params.subtitle_text_color],
  ];
  for (const [varName, value] of map) {
    if (value) root.style.setProperty(varName, value);
  }
  if (root.classList) {
    root.classList.toggle('dark', params.bg_color !== undefined && isDarkColor(params.bg_color));
  }
}

function isDarkColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

/**
 * Initialize the Telegram WebApp SDK: ready(), expand(), header color and
 * themeParams wiring. Call once from the app entrypoint. Safe outside Telegram.
 */
export function initTelegram(): void {
  const tg = sdk();
  applyMonoScheme(tg ?? undefined);
  if (tg) {
    wire(tg);
    return;
  }
  // Not available yet — keep looking instead of writing off the whole session.
  void whenTelegramReady();
}

/** Wire an SDK instance once: ready(), expand(), theme and chrome. */
function wire(tg: TelegramWebApp): void {
  if (webApp === tg) return;
  webApp = tg;
  try {
    tg.ready();
    tg.expand();
    paintChrome(tg);
    applyThemeParams(tg.themeParams);
    tg.onEvent('themeChanged', () => {
      applyThemeParams(tg.themeParams);
      applyMonoScheme(tg);
      paintChrome(tg);
    });
  } catch {
    // SDK failures must never break the app (e.g. running in a plain browser).
  }
}

/**
 * The app is a strict black-and-white theme (see mono-theme.css). It only
 * follows Telegram for WHICH of the two: dark chat -> black, light chat ->
 * white. Outside Telegram it follows the browser's own preference.
 */
function applyMonoScheme(tg?: TelegramWebApp): 'light' | 'dark' {
  let scheme: 'light' | 'dark' = 'dark';
  if (tg?.colorScheme === 'light') scheme = 'light';
  else if (tg?.colorScheme === 'dark') scheme = 'dark';
  else if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    scheme = 'light';
  }
  document.documentElement.dataset.scheme = scheme;
  return scheme;
}

/** Keep Telegram's own header and background the same black/white as the app. */
function paintChrome(tg: TelegramWebApp): void {
  const color = document.documentElement.dataset.scheme === 'light' ? '#ffffff' : '#0a0a0a';
  tg.setHeaderColor(color);
  tg.setBackgroundColor(color);
}

/* ---------- Haptic feedback ---------- */

export function hapticSuccess(): void {
  try {
    webApp?.HapticFeedback.notificationOccurred('success');
  } catch {
    /* noop */
  }
}

export function hapticError(): void {
  try {
    webApp?.HapticFeedback.notificationOccurred('error');
  } catch {
    /* noop */
  }
}

export function hapticWarning(): void {
  try {
    webApp?.HapticFeedback.notificationOccurred('warning');
  } catch {
    /* noop */
  }
}

export function hapticTap(): void {
  try {
    webApp?.HapticFeedback.impactOccurred('light');
  } catch {
    /* noop */
  }
}

/* ---------- Telegram BackButton ---------- */

type BackHandler = () => void;
let backHandler: BackHandler | null = null;
let backWired = false;

function wireBack(): void {
  if (!webApp || backWired) return;
  backWired = true;
  try {
    // Some Telegram clients expose `window.Telegram.WebApp` with an older
    // Bot API version (BackButton pre-dates Bot API 6.1) or a partial
    // implementation — `BackButton` or `.onEvent` can be missing even though
    // the SDK object itself loaded. This must never throw and take the whole
    // page down with it (every page with a back button calls this).
    if (typeof webApp.BackButton?.onEvent === 'function') {
      webApp.BackButton.onEvent((type) => {
        if (type === 'press' && backHandler) backHandler();
      });
    }
  } catch {
    /* noop — the on-screen back button (rendered regardless) still works */
  }
}

/** Show the Telegram hardware BackButton and handle press (default: go back). */
export function backButtonShow(handler?: BackHandler | null): void {
  if (!webApp) return;
  wireBack();
  backHandler = handler ?? null;
  try {
    webApp.BackButton.show();
  } catch {
    /* noop */
  }
}

export function backButtonHide(): void {
  backHandler = null;
  if (!webApp) return;
  try {
    webApp.BackButton.hide();
  } catch {
    /* noop */
  }
}

/** Close the mini app (informs the user via haptics). */
export function closeApp(): void {
  try {
    webApp?.close();
  } catch {
    /* noop */
  }
}

/**
 * Open a t.me link. Inside Telegram this hands off to `WebApp.openTelegramLink`,
 * which Telegram's own client intercepts and opens in-app (a plain `<a>` or
 * `window.open` to a t.me URL does not reliably do this inside the Mini App
 * webview). Falls back to a top-level navigation — never `window.open`, which
 * several Telegram WebView builds silently block for popups with no error and
 * no visible effect, which is worse than a fallback that does nothing.
 */
export function openTelegramLink(url: string): void {
  try {
    if (webApp && typeof webApp.openTelegramLink === 'function') {
      webApp.openTelegramLink(url);
      return;
    }
  } catch {
    /* fall through to the plain-navigation fallback below */
  }
  window.location.href = url;
}

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /**
   * '1' when a real LLM key is wired in. Absent/anything else means the AI
   * assistant runs the deterministic tool-calling stub, and the widget says so.
   */
  readonly VITE_AI_LIVE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/* Minimal Telegram WebApp SDK type surface (subset we consume). */

export interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  subtitle_text_color?: string;
  accent_text_color?: string;
}

export interface TelegramHapticFeedback {
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  selectionChanged(): void;
}

export interface TelegramBackButton {
  isVisible: boolean;
  show(): void;
  hide(): void;
  onEvent(cb: (type: 'show' | 'press') => void): void;
  offEvent(cb: (type: 'show' | 'press') => void): void;
}

export interface TelegramWebApp {
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark' | 'unknown';
  initData: string;
  initDataUnsafe: Record<string, unknown>;
  themeParams: TelegramThemeParams;
  isExpanded: boolean;
  viewportStableHeight: number;
  ready(): void;
  expand(): void;
  close(): boolean;
  openTelegramLink?(url: string): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  setBottomTabBarColor(color: string): void;
  HapticFeedback: TelegramHapticFeedback;
  BackButton: TelegramBackButton;
  onEvent(event: 'themeChanged' | 'viewportChanged' | 'resize', cb: () => void): void;
  offEvent(event: 'themeChanged' | 'viewportChanged' | 'resize', cb: () => void): void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export {};

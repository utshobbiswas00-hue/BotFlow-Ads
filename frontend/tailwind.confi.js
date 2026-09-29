/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /*
         * Surface tokens follow the Telegram theme so the Mini App looks native
         * inside a chat. The `brand*` / `earn` / `spend` tokens below are
         * BotFlow's OWN identity, used for data, charts and money — never for
         * chrome, so Telegram theming always wins where it should.
         */
        app: 'var(--tg-theme-bg-color, #f3f4f6)',
        surface: 'var(--tg-theme-secondary-bg-color, #ffffff)',
        raised: 'var(--tg-theme-section-bg-color, #ffffff)',
        ink: 'var(--tg-theme-text-color, #111827)',
        mute: 'var(--tg-theme-hint-color, #6b7280)',
        sub: 'var(--tg-theme-subtitle-text-color, #6b7280)',
        line: 'var(--tg-theme-outline-color, #e5e7eb)',
        accent: 'var(--tg-theme-button-color, #2481cc)',
        accentink: 'var(--tg-theme-button-text-color, #ffffff)',
        link: 'var(--tg-theme-link-color, #2481cc)',
        danger: 'var(--tg-theme-destructive-text-color, #dc2626)',

        /* Strict black and white. These follow --fg-rgb / --mut-rgb from
           mono-theme.css, so they flip with the light/dark scheme and still
           accept opacity modifiers (bg-ok/10 etc.). */
        brand: 'rgb(var(--fg-rgb) / <alpha-value>)',
        brandBlue: 'rgb(var(--fg-rgb) / <alpha-value>)',
        brandLight: 'rgb(var(--fg-rgb) / <alpha-value>)',
        brandDeep: 'rgb(var(--fg-rgb) / <alpha-value>)',
        brandViolet: 'rgb(var(--mut-rgb) / <alpha-value>)',
        brandCyan: 'rgb(var(--mut-rgb) / <alpha-value>)',

        earn: 'rgb(var(--fg-rgb) / <alpha-value>)',
        earnSoft: 'rgb(var(--mut-rgb) / <alpha-value>)',
        spend: 'rgb(var(--mut-rgb) / <alpha-value>)',
        info: 'rgb(var(--mut-rgb) / <alpha-value>)',
        ok: 'rgb(var(--fg-rgb) / <alpha-value>)',
        warn: 'rgb(var(--mut-rgb) / <alpha-value>)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      backgroundImage: {
        'brand-gradient': 'none',
        'earn-gradient': 'none',
        'brand-sheen': 'none',
      },
      boxShadow: {
        kpi: '0 0 0 1px rgb(var(--ln-rgb))',
        card: '0 0 0 1px rgb(var(--ln-rgb))',
        sheet: '0 0 0 1px rgb(var(--ln-rgb))',
      },
      borderRadius: {
        lg: '0.5rem',
        xl: '0.625rem',
        '2xl': '0.75rem',
        '3xl': '0.875rem',
        '4xl': '1rem',
      },
      maxWidth: {
        app: '430px',
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        slideup: {
          '0%': { transform: 'translateY(16px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        countup: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        slideup: 'slideup 0.18s ease-out',
        countup: 'countup 0.28s cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};

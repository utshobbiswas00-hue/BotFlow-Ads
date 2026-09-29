import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env from the monorepo root first, then the backend folder.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

const bool = (def: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .default(def)
    .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .union([z.string(), z.number()])
    .default(def)
    .transform((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
    .refine((v) => Number.isFinite(v), 'must be an integer');

const envSchema = z.object({
  // Core
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(10000),
  APP_URL: z.string().url().default('http://localhost:10000'),
  MINI_APP_URL: z.string().default('http://localhost:5173'),
  /**
   * Optional override for the directory holding the built Mini App
   * (`frontend/dist`). Leave unset in production — the app resolves
   * `<repo>/frontend/dist` on its own. Set it if the SPA is copied somewhere
   * else in the image. Empty string means "resolve automatically".
   */
  SERVE_SPA_DIR: z.string().default(''),
  TZ: z.string().default('Asia/Dhaka'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Infrastructure
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_BOT_USERNAME: z.string().default('BotflowadsBot'),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
   TELEGRAM_ADMIN_IDS: z
     .string()
     .default('')
     .transform((v) =>
       v
         .split(',')
         .map((s) => s.trim())
         .filter(Boolean),
     ),
   // Only needed for the OPTIONAL MTProto view reader. The Telegram Bot API does not expose per-post view counts, so reading views requires a user-account session. Leave blank to run without view measurement.
   TELEGRAM_API_ID: z.string().default(''),
   TELEGRAM_API_HASH: z.string().default(''),
   TELEGRAM_SESSION: z.string().default(''),

   // OPTIONAL TRON (TRC-20) deposit scanning via TronGrid. Leave blank to run
   // without it — the deposit address is still shown, and any transfer is
   // simply caught up by the next release rather than credited automatically.
   TRON_TRONGRID_API_URL: z.string().default(''),
   TRON_TRONGRID_API_KEY: z.string().default(''),

  // Security
  JWT_SECRET: z.string().default('dev_jwt_secret_change_me'),
  ENCRYPTION_KEY: z.string().default('0'.repeat(64)),

  // Payments
  PAYMENT_WEBHOOK_SECRET: z.string().default(''),

  /**
   * JSON-RPC endpoints for the EVM chains we watch for crypto deposits, as a
   * JSON object of network -> URL:
   *
   *   {"USDT_BEP20":"https://…","USDT_ERC20":"https://…"}
   *
   * EMPTY by default, and deliberately never defaulted to a real endpoint: we
   * call what we have been given and nothing else. A network with no endpoint is
   * simply not scanned — its transfers wait in the operator queue rather than
   * being silently missed — and the addresses are still shown to customers, so a
   * gap costs a manual settlement, not a lost deposit.
   *
   * The provider needs an API key for any real volume; that key belongs in the
   * URL or a header, and this is where the URL goes.
   */
  CRYPTO_RPC_URLS: z
    .string()
    .default('{}')
    .transform((raw) => {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, string>;
        }
      } catch {
        // Unparseable config must not stop the process from booting: it degrades
        // to "no chains scanned", which the operator queue makes visible.
      }
      return {} as Record<string, string>;
    }),

  // Business defaults
  DEFAULT_CURRENCY: z.string().default('USD'),
  DEFAULT_PLATFORM_FEE_PERCENT: int(20),
  MIN_WITHDRAWAL_CENTS: int(500),
  MAX_WITHDRAWAL_CENTS: int(100000),
  WITHDRAWAL_FEE_CENTS: int(0),
  MIN_CAMPAIGN_BUDGET_CENTS: int(500),
  MIN_CHANNEL_POST_PRICE_CENTS: int(100),
  MAX_CHANNEL_POST_PRICE_CENTS: int(1000000),
  EARNING_HOLD_HOURS: int(24),
  REFERRAL_REWARD_CENTS: int(100),

  // Fraud
  MAX_CLICKS_PER_USER_PER_MINUTE: int(20),
  MAX_CLICKS_PER_IP_PER_MINUTE: int(60),
  MAX_CTR_THRESHOLD: z
    .union([z.string(), z.number()])
    .default(0.3)
    .transform((v) => (typeof v === 'number' ? v : Number.parseFloat(v))),
  MIN_ACCOUNT_AGE_MINUTES_FOR_EARN: int(10),

  // Flags
  ENABLE_AUTO_TARGETING: bool(true),
  ENABLE_MAINTENANCE_MODE: bool(false),
  SENTRY_DSN: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`\n[env] Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }

  // Production hardening. Two tiers:
  //   FATAL   — the value is a known-public default that anyone reading this
  //             source can guess, and the thing it protects (session tokens,
  //             encrypted-at-rest data, the bot webhook) is actively
  //             insecure while it is unset. Booting anyway means shipping a
  //             deployment that LOOKS configured but is not. Refuse to start.
  //   WARNING — a real feature gap (bot disabled, a payment rail
  //             unconfigured), not a security hole. The app is still safe to
  //             run without it, so it only logs.
  const e = parsed.data;
  if (e.NODE_ENV === 'production') {
    const fatal: string[] = [];
    if (e.JWT_SECRET.includes('change_me') || e.JWT_SECRET.includes('dev_'))
      fatal.push(
        'JWT_SECRET is still the default value — every session token is forgeable by anyone who has read this source.',
      );
    if (e.ENCRYPTION_KEY === '0'.repeat(64))
      fatal.push('ENCRYPTION_KEY is still the default value — anything "encrypted" with it is not.');
    // The webhook secret only matters once the bot can actually receive
    // updates; an unconfigured bot has nothing to authenticate.
    if (e.TELEGRAM_BOT_TOKEN && !e.TELEGRAM_WEBHOOK_SECRET)
      fatal.push(
        'TELEGRAM_WEBHOOK_SECRET is empty while TELEGRAM_BOT_TOKEN is set — the bot webhook would accept unauthenticated requests from anyone who finds its URL.',
      );

    if (fatal.length) {
      // eslint-disable-next-line no-console
      console.error(
        `\n[env] Refusing to start in production with insecure defaults:\n${fatal.map((p) => `  - ${p}`).join('\n')}\n\nSet real values for these before deploying.\n`,
      );
      process.exit(1);
    }

    const warnings: string[] = [];
    if (!e.TELEGRAM_BOT_TOKEN) warnings.push('TELEGRAM_BOT_TOKEN is empty — bot will not start');
    if (!e.TELEGRAM_ADMIN_IDS.length) {
      warnings.push(
        'TELEGRAM_ADMIN_IDS is empty — admin alerts (failed deliveries, duplicate charges, ' +
          'deposit/withdrawal review, fraud) will be delivered to nobody.',
      );
    }
    if (e.TELEGRAM_BOT_TOKEN && (e.APP_URL.startsWith('http://') || e.APP_URL.includes('localhost'))) {
      warnings.push(
        `APP_URL is "${e.APP_URL}" — Telegram requires a public HTTPS URL for the webhook. Set APP_URL ` +
          'to this service\'s real HTTPS URL (e.g. your Render service URL) or the bot webhook will fail ' +
          'to register and the bot will not receive updates.',
      );
    }
    if (warnings.length) {
      // eslint-disable-next-line no-console
      console.warn(`\n[env] Production warnings:\n${warnings.map((p) => `  - ${p}`).join('\n')}\n`);
    }
  }

  return e;
}

export const env = loadEnv();

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

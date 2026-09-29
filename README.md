# BotFlow Ads — User Panel

> **Scope of this build:** this repository contains the **user-facing (Mini App) panel only** — the
> advertiser and publisher experience. The staff/admin dashboard is **not bundled here**; it ships
> separately and talks to the same backend API.
>
> Because of that, the frontend has **21 user pages** and no `/admin` route. The **backend is
> complete and unchanged** — it still exposes the `/api/admin/*` endpoints, because campaign
> approval, channel approval, deposit verification and withdrawal payout are part of the core
> money loop. Without them the user panel could create campaigns but nothing could ever be
> approved or paid out. The future admin panel plugs into those existing endpoints.

BotFlow Ads is a **Telegram-native sponsored-post ad network**: advertisers buy
impressions on approved publisher channels, publishers earn money every time
their channel runs a sponsored post, and **a single Telegram user can be both
roles at once** — the same account (and the same wallet) can deposit to run
campaigns and withdraw channel earnings. The whole product lives inside
Telegram: a grammY bot drives onboarding and approvals, a React **Mini App**
is the dashboard (advertiser + publisher), and a separate always-on
worker publishes the sponsored posts, manages escrow and releases matured
earnings. Money is real money, so every balance movement is written to an
append-only ledger — see [Money rules](#money-rules).

## Architecture

Five runtime pieces, each separate on Render for a concrete reason:

| Piece | What it is | Why it is separate on Render |
|---|---|---|
| **API** (`botflow-api`) | Express + grammY bot. Serves the Mini App's REST API, the Telegram webhook (`POST /webhook/telegram`), and the public click-tracking redirect (`/c/<slug>`). | It is stateless and bursty. Render web services scale on traffic and **sleep when idle** — perfect for HTTP request/response work, but which is exactly why it must not hold a Telegram long-polling connection or run delivery timers. |
| **Worker** (`botflow-worker`) | BullMQ worker process (`src/workers/index.ts`). Runs **all** delayed and recurring work: publishing scheduled posts, starting/expiring campaigns, permission checks, stats sync, earnings release, withdrawals, fraud scans, notifications, cleanup. | Scheduled delivery must fire at a precise time even when no one is using the app. A Render web instance can be asleep, so the timing has to live in **Redis (BullMQ delayed jobs)** and be executed by a **24/7 worker instance** instead of in-process timers. |
| **Static Mini App** (`botflow-app`) | Vite/React build of the Telegram Mini App + admin panel, served as static files with an SPA rewrite (`/* → /index.html`). | A static site needs no Node process at all — it is cheaper, faster and has nothing to sleep. It must be its own origin anyway so the Mini App URL and the API URL can differ (CORS, webhook `APP_URL`, `VITE_API_URL` build-time config). |
| **Postgres** (`botflow-db`) | Managed PostgreSQL. The ledger, wallets, campaigns, channels and every admin audit trail. | The ledger is the source of truth for money; it needs real transactions, row locks and a durable unique index on `transactions.reference`. A managed service gives that with backups and zero box management. |
| **Redis** (`botflow-kv`) | Managed Key Value (Redis). BullMQ queue storage, rate-limit counters, idempotency locks. | The API (producer) and the worker (consumer) must share one queue store, and rate limiting has to hold across all API instances — an in-process store can't do either. |

In production the API and the worker share the same build and the same
`DATABASE_URL` / `REDIS_URL`; only the start command differs
(`npm run start:api` vs `npm run start:worker`).

## Quick start (local)

Requires Node ≥ 20, npm ≥ 10 and Docker (for Postgres + Redis).

```bash
# 1. Install all workspaces (shared, backend, frontend)
npm install

# 2. Start local Postgres 16 + Redis 7 (docker compose)
npm run infra:up

# 3. Configure the environment
cp .env.example .env
#    then edit .env — at minimum set TELEGRAM_BOT_TOKEN,
#    TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ADMIN_IDS, JWT_SECRET, ENCRYPTION_KEY

# 4. Generate the Prisma client, apply migrations, seed
npm run db:generate
npm run db:migrate
npm run db:seed

# 5. Run the three processes (three terminals)
npm run dev:api        # Express API + bot on http://localhost:10000
npm run dev:worker     # BullMQ worker (all scheduled work)
npm run dev:frontend   # Mini App on http://localhost:5173
```

Useful extras:

```bash
npm run infra:down     # stop local Postgres + Redis
npm run db:studio      # Prisma Studio against the local DB
npm run typecheck      # backend + frontend
npm run test           # backend unit tests (vitest)
npm run setup          # install + db:generate + db:deploy + db:seed (production-style migrate)
```

The local Postgres/Redis credentials in `docker-compose.yml`
(`botflow / botflow_dev_pass`, db `botflow_ads`, Redis with AOF +
`noeviction`) already match the defaults in `.env.example`, so no extra
wiring is needed for development.

## Telegram setup

1. **Create the bot.** Talk to [@BotFather](https://t.me/BotFather) →
   `/newbot`, pick a name and a username, and copy the **bot token**.
   Put it in `.env` as `TELEGRAM_BOT_TOKEN` (production: in the Render
   dashboard, see `render.yaml`).
2. **Webhook secret.** Invent a long random string
   (e.g. `openssl rand -hex 32`) and set `TELEGRAM_WEBHOOK_SECRET`.
   It is sent to Telegram via `setWebhook(secret_token=...)` and checked on
   every inbound update (`X-Telegram-Bot-Api-Secret-Token`).
3. **Admins.** Set `TELEGRAM_ADMIN_IDS` to your own Telegram user id
   (comma-separated for several). `npm run db:seed` creates a
   `SUPER_ADMIN` row for each id; `/start` in the bot then boots them into
   the admin panel.
4. **Mini App.** In @BotFather: `/newapp` (or *Bot Settings → Menu Button*)
   and point it at the **Mini App URL** — locally
   `http://localhost:5173`, in production the `botflow-app` service URL.
   The API's `MINI_APP_URL` / `ADMIN_PANEL_URL` should match, so the bot can
   deep-link.
5. **Webhook registration.** In production (`NODE_ENV=production`) the API
   **registers the webhook automatically on boot** at
   `${APP_URL}/webhook/telegram` — so `APP_URL` must be the deployed
   API's public HTTPS URL. Locally the bot uses long polling instead, so
   nothing needs to be registered.

## Deploy to Render

1. Push the repo to GitHub/GitLab and create a **Blueprint** in Render
   ("New → Blueprint") — it reads `render.yaml`, which declares
   `botflow-db` (Postgres), `botflow-kv` (Redis) and the three services
   `botflow-api`, `botflow-worker`, `botflow-app`, all `autoDeploy: true` in
   the Singapore region.
2. Fill in every `sync: false` environment variable in the Render dashboard:
   the Telegram secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
   `TELEGRAM_ADMIN_IDS`, `TELEGRAM_BOT_USERNAME`), the security secrets
   (`JWT_SECRET`, `ENCRYPTION_KEY`), the optional payment secrets
   (`PAYMENT_WEBHOOK_SECRET`),
   and the deployment URLs — most importantly `APP_URL` on `botflow-api`
   (its own public URL — the webhook and click-tracking links are built
   from it) and `VITE_API_URL` on `botflow-app` (the API's public URL).
   Rebuild `botflow-app` after changing `VITE_API_URL` (it is baked in at
   build time).
3. Check the current Render plans in the dashboard: the **worker** must be
   on an instance type that runs continuously (a sleeping worker means
   scheduled posts stop firing — see the top of `render.yaml`).
4. Confirm all three services come up: `botflow-api` healthy on `/health`,
   `botflow-worker` logging its queue health banner, and `botflow-app`
   serving the SPA. Then `db:deploy` runs on each API/worker build and the
   seed is safe to run manually once against the managed database
   (`npx prisma migrate deploy && npx prisma db seed` from `backend/`, with
   `DATABASE_URL` pointing at `botflow-db`) to create the initial settings
   and your SUPER_ADMIN.

## Money rules

- **Every amount is an integer in minor units (cents).** No floats anywhere
  in storage or API contracts — the Prisma schema uses `Int @map("…_cents")`
  for all money.
- **The `transactions` ledger is append-only and is the source of truth.**
  Rows are never updated or deleted (status aside). Wallet columns
  (`availableCents`, `reservedCents`, `pendingCents`, totals) are
  denormalised for fast reads, but a balance dispute is always settled by
  replaying the ledger.
- **Balances are never updated outside `postLedger`.** Every money movement
  goes through `postLedger()` inside the same DB transaction as the business
  change it represents, using SQL arithmetic (plus row-level wallet locks)
  so concurrent requests cannot lose an update.
- **Every money path is idempotent via a unique ledger `reference`.** Each
  operation has exactly one reference convention — e.g.
  `escrow:hold:<campaignId>`, `charge:<adPostId>`, `earning:<adPostId>`,
  `escrow:release:<campaignId>` — and `transactions.reference` is a unique
  index, so a replayed webhook or retried worker cannot double-credit or
  double-charge; the whole transaction rolls back instead.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full escrow
flow, delivery pipeline and security model.

## Honest limitations

- **Telegram does not reliably expose channel post view counts.** The Bot
  API gives us views for some posts (notably after `channel_post` updates
  arrive) but there is no dependable per-post view endpoint. BotFlow
  therefore only reports view/impression metrics **where Telegram actually
  returns them**, stores them as snapshots in `impressions`, and **never
  fabricates or estimates views** for display.
- Because real CPM/CPC outcomes can't be measured reliably from Telegram,
  **CPM/CPC pricing charges an up-front estimate**: the price for a post is
  resolved at publish time from the channel's rates and its average
  performance (CPC assumes a 2% CTR), charged once from escrow, and never
  re-charged afterwards. FIXED pricing is always exact.

## Project structure

```
botflow-ads/
├── package.json            # npm workspaces + root scripts (dev:*, db:*, infra:*)
├── .env.example            # copy to .env and fill in
├── docker-compose.yml      # local Postgres 16 + Redis 7 (npm run infra:up)
├── render.yaml             # Render Blueprint (production topology)
├── shared/                 # @botflow/shared — types & constants used by all sides
├── backend/                # @botflow/backend — Express API + grammY bot + BullMQ workers
│   ├── prisma/
│   │   ├── schema.prisma   # Postgres schema (integer-cents money model)
│   │   ├── migrations/
│   │   └── seed.ts         # idempotent seed (npm run db:seed)
│   └── src/
│       ├── bot/            # grammY bot: commands, webhook wiring, keyboards
│       ├── config/         # env (zod-validated), constants, logger
│       ├── db/             # Prisma client, Redis client, tx helpers
│       ├── middleware/     # telegramAuth (initData HMAC), adminAuth, rateLimit, …
│       ├── queues/         # BullMQ producers, queue names, repeatable schedules
│       ├── services/       # campaign, delivery, escrow, wallet, fraud, …
│       ├── templates/      # sponsored-post text templates
│       ├── types/          # shared types + Express augmentation
│       ├── utils/          # crypto, money, telegram client, errors, …
│       └── workers/        # BullMQ worker entry + one module per queue
├── frontend/               # @botflow/frontend — React + Vite Telegram Mini App
│   └── src/                # pages/, components/, hooks/, store/, lib/
└── docs/
    └── ARCHITECTURE.md     # lifecycle, escrow, delivery, workers, fraud, security
```

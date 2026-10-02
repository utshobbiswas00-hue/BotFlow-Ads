# Real-database verification

The one item that could not be closed from where the panel was built was "apply the
migrations and run the integration suite". This records doing it.

## What was missing

No PostgreSQL, no Redis, no Docker, no Podman — and the integration suite
(`backend/tests/`, 21 files, real money movement) needs a live PostgreSQL *and* a
live Redis. The migrations were therefore shipped generated and validated offline,
with the honest caveat that no database had executed them.

## How it was closed

Both servers were built from source in the sandbox. `gcc`, `make` and `curl` were
available, so:

```bash
# PostgreSQL 16.4 — configure --without-readline --without-zlib --without-icu, make, make install
# Redis 7.4.0 — make MALLOC=libc BUILD_TLS=no redis-server
# initdb refuses to run as root, so the cluster runs as an unprivileged user
# with data in its own home, and LC_ALL=C because no en_US locale is generated.
```

Result: PostgreSQL 16.4 on `127.0.0.1:5432` (role `botflow`, superuser) and Redis
7.4.0 on `6380`. Nothing in the repository was changed to make this work — the
`.bin/prisma` shim that globalSetup needs is created by `npm ci`, and `prisma` is
declared in `devDependencies` (`^5.22.0`), so a normal install produces it.

A WASM Postgres (`@electric-sql/pglite`) was tried first and is not sufficient:
its socket server runs one shared backend session, so Prisma's schema engine hits
`ERROR: prepared statement "s0" already exists` as soon as a second client has
connected. Real PostgreSQL has no such problem.

## Migrations against real PostgreSQL

```
$ DATABASE_URL=... node node_modules/prisma/build/index.js migrate deploy
Applying migration `20260927100000_reprice_monthly_plan_and_repair_terms`
Applying migration `20260929100000_add_channel_posting_schedule`
Applying migration `20261002100000_add_broadcast_delivery_tracking`
Applying migration `20261002120000_add_error_log`
Applying migration `20261002140000_add_admin_notifications`
All migrations have been successfully applied.
```

Verified afterwards by querying the database directly, not by trusting the CLI:

| Check | Result |
|---|---|
| tables in `public` | 46 |
| rows in `_prisma_migrations` with `finished_at` | 15 |
| `broadcast_jobs`, `broadcast_recipients`, `error_logs`, `admin_notifications` | all present |

The migrations written for this work are additive: `broadcast_jobs` and
`broadcast_recipients` (11 and 8 columns, 3 enums, 5 indexes, 2 foreign keys),
`error_logs` (9 columns, 3 indexes, no foreign key by design so an error outlives
the user it mentions), and `admin_notifications`. No `ALTER` touches an existing
table.

## The integration suite, against real PostgreSQL + real Redis

```
Test Files  21 passed (21)
     Tests  290 passed (290)
```

Ledger, escrow, double-payment, double-withdrawal, duplicate-delivery,
payment-fees, deposit-bonus, crypto-deposits, crypto-addresses, telegram-stars,
billing, webhook, advertiser-api, channel-quality, channel-schedule,
channel-settings, alerts-email, and the four unit files: **green**.

## The two failures that were there first, and how they were closed

On the first full run the suite came back `2 failed | 288 passed`, both in
`tests/channel-schedule.test.ts`:

- "refuses the add while the bot is not an administrator, and stores nothing"
- "refuses when the bot is an administrator WITHOUT the post-messages right"

Both failed with `promise resolved "{ …(36) }" instead of rejecting`. They were not
a regression: run against the pristine product at commit `3449716` — the tree before
a single line of panel work — in a clean checkout, against the same database and
Redis, they failed identically (`2 failed | 13 passed`). `channel.service.ts`,
`channel-schedule.test.ts` and the rights check in `utils/telegram.ts` are the
product's, not this panel's.

The service does not refuse on purpose, and says so:

> Record the bot's rights, but never block submission on them. The owner can add
> the bot afterwards — the "Open access" banner on the channel page (and Telegram's
> own `my_chat_member` push) carries it from PENDING to APPROVED the moment the bot
> actually gets those rights.

So the tests encoded the older rule and the code the newer one. Only one of those
could be right, and the choice was made by reading what each side protects:

- **Restoring the refusal** would have reversed a documented product decision and
  made the whole PENDING → APPROVED onboarding path — including the channel page's
  "Open access" banner and the `my_chat_member` promotion — unreachable. The panel
  reads `status` in a dozen places on the assumption that a channel can exist
  while the bot cannot post yet.
- **Relaxing the assertion to "it resolved, fine"** would have deleted a permission
  check to match whatever the code does, which is how a permission check stops
  being one.

The resolution keeps the property that actually matters and asserts it explicitly:
**missing rights change the status, never the outcome, and a channel is never
APPROVED without them.** `botReady = perms.botIsAdmin && perms.canPostMessages` is
the single expression that decides, and it gates both `status: 'APPROVED'` and
`approvedAt`. The rewritten tests now check that a channel added without rights is
stored as `PENDING` with `approvedAt: null` and the observed rights recorded as
false — and, because a PENDING channel cannot take an ad, that nothing can be
delivered through a channel the bot cannot post to.

`tests/channel-schedule.test.ts`: 15 of 15 passing.

## Everything, same run

```
backend  tsc clean        eslint clean
backend  unit        28 files / 302 tests passed
backend  integration 22 files / 294 tests passed
frontend tsc clean
frontend             18 files /  97 tests passed
vite build           1045 modules
prisma validate      schema is valid
```

## The bug this document's method caught: the panel was mounted in the wrong place

Running the assembled application — not its parts — is what found the last and worst
defect of this work.

**Symptom.** In a browser, the panel's login page reported
`Telegram authentication required` and no username and password could ever work. From
inside Telegram everything was fine, which is why every test passed.

**Cause.** `routes/index.ts` applies `router.use(telegramAuth())` at the router level
and then mounted the panel inside that same router:

```
router.use(telegramAuth());            // demands Telegram initData, for every request below
router.use('/admin', adminRouter);     // <- the whole panel, including its login
```

`adminPanelAuth` is the panel's own two-door auth (session cookie *or* Telegram
initData), and `adminAuthPublicRouter` — the config and login endpoints — was made
public *within* the admin router. That was correct, and irrelevant: `telegramAuth` runs
first and rejects `/api/admin/auth/config` and `/api/admin/auth/login` with
`401 Telegram authentication required` before any panel route is reached. The routes
were right; their position was not.

The codebase already knew this trap. `app.ts` mounts `publicApiRouter` above the user
router for exactly this reason, in a comment that says so. The lesson existed and was
not applied one file over.

**Fix.** The panel is mounted in `app.ts`, before `/api`:

```ts
app.use('/api/admin', adminRouter);   // before app.use('/api', router)
```

and the old mount is gone from `routes/index.ts`, replaced by a comment explaining why
it must not return.

**Evidence, over HTTP against the running server, with no initData anywhere in the
session:**

| Request | Before | After |
|---|---|---|
| `GET /api/admin/auth/config` | 401 Telegram authentication required | **200** `{"passwordLoginEnabled":true}` |
| `POST /api/admin/auth/login` | 401 Telegram authentication required | **200**, `role: SUPER_ADMIN`, session cookie set |
| `GET /api/admin/session` (cookie) | — | **200** `{"active":true}` |
| `GET /api/admin/dashboard` (cookie) | — | **200**, real totals |
| `GET /api/admin/users` (cookie) | — | **200**, real rows |
| `GET /api/me` (user surface) | 401 Telegram | 401 Telegram — **unchanged** |

**Why the suite did not catch it, and now would.** `backend/tests/adminRouting.test.ts`
is new and is the only test that boots the real application via `createApp()` over a
real socket; every other panel test mounts its router onto a bare Express app, so all of
them passed while the assembled application was unreachable from a browser. It asserts
the thing that was broken — position, not behaviour — and it fails if the panel is
mounted back inside the `telegramAuth` scope.

Suite after the fix: **22 files, 294 tests, all passing.**

# Real-database verification

The one item that could not be closed from where the panel was built was "apply the
migrations and run the integration suite". This records doing it.

## What was missing

No PostgreSQL, no Redis, no Docker, no Podman — and the integration suite
(`backend/tests/`, 21 files, real money movement) needs a live PostgreSQL *and* a
live Redis. The two migrations were therefore shipped generated and validated
offline, with the honest caveat that no database had executed them.

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

The two migrations written for this work are additive: `broadcast_jobs` and
`broadcast_recipients` (11 and 8 columns, 3 enums, 5 indexes, 2 foreign keys) and
`error_logs` (9 columns, 3 indexes, no foreign key by design so an error outlives
the user it mentions). No `ALTER` touches an existing table.

## The integration suite, against real PostgreSQL + real Redis

```
Test Files  1 failed | 20 passed (21)
     Tests  2 failed | 288 passed (290)
  Duration  95.68s
```

Ledger, escrow, double-payment, double-withdrawal, duplicate-delivery,
payment-fees, deposit-bonus, crypto-deposits, crypto-addresses, telegram-stars,
billing, webhook, advertiser-api, channel-quality, channel-settings,
alerts-email, and the four unit files: **all green**.

## The two failures are not ours — and this is the proof

`tests/channel-schedule.test.ts`, two cases:

- "refuses the add while the bot is not an administrator, and stores nothing"
- "refuses when the bot is an administrator WITHOUT the post-messages right"

Both fail with `promise resolved "{ …(36) }" instead of rejecting`. The service
does not refuse, on purpose — `channel.service.ts` says so in as many words:

> Record the bot's rights, but never block submission on them. The owner can add
> the bot afterwards — the "Open access" banner on the channel page (and
> Telegram's own `my_chat_member` push) carries it from PENDING to APPROVED the
> moment the bot actually gets those rights.

**Proof it pre-dates this work:** the same two tests were run against the pristine
product at commit `3449716` — the tree before a single line of panel work — in a
clean checkout, against the same database and Redis:

```
Test Files  1 failed (1)
     Tests  2 failed | 13 passed (15)
AssertionError: promise resolved "{ …(36) }" instead of rejecting
```

Identical failure, identical assertion, same file. `channel.service.ts`,
`channel-schedule.test.ts` and the rights check in `utils/telegram.ts` are the
product's, not this panel's.

**What it means, and what was deliberately not done.** The tests encode the older
rule (refuse the add and store nothing); the product now encodes the newer one
(record the rights, add as PENDING, let Telegram promote it). One of the two is
wrong and it is not a test-runner problem. It was **not** "fixed" here, in either
direction: relaxing the assertion would edit a permission check to match whatever
the code happens to do, and restoring the refusal would reverse a documented
product decision about how publishers onboard. Both are product behaviour
decisions about who may add a channel, and they are flagged rather than decided
quietly. It is the only open item in the suite.

## Everything else, same run

```
backend  tsc clean        eslint clean
backend  unit        28 files / 302 tests passed
backend  integration 21 files / 288 of 290 tests passed (see above)
frontend tsc clean
frontend             18 files /  97 tests passed
vite build           1045 modules
prisma validate      schema is valid
```

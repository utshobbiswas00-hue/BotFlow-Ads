# BotFlow Ads — Project Inventory

Everything below was read out of the repository in this session. No file was modified.
Where something is absent, it is stated as absent rather than inferred.

Repo root: `/home/wuying/.accio/accounts/7098518773/agents/DID-82AD6B-7882AD6BU1790609-3936-91C0F8/project/BotFlow-Ads`

---

## 1. Backend framework and entry point

| Item | Value |
|---|---|
| Framework | **Express `^4.21.1`** (no Fastify/Koa) |
| Language / runtime | TypeScript, compiled with `tsc`; dev via `tsx watch` |
| API package | `@botflow/backend` (`backend/package.json`) |
| **HTTP entry point** | **`backend/src/index.ts`** (161 lines) |
| App factory | `backend/src/app.ts` (235 lines) — `createApp()` |
| **Worker entry point** | **`backend/src/workers/index.ts`** (106 lines) |
| Boot sequence | `index.ts:6` imports `runMigrationsOnBoot` from `./db/migrate`; verifies DB (`:31`) and Redis (`:39`); `server.listen(env.PORT, '0.0.0.0')` (`:115`) |
| App-level middleware order | `app.ts:172` `requestId` → `:175` `bigintSafeJson()` → `:178` `webhookRouter` (raw body) → `:181` `express.json({limit:'1mb'})` → `:194` `publicApiRouter` → `:198` `maintenanceGuard()` → `:201` `app.use('/api', limiters.global)` → `:204` `app.use('/health', healthRouter)` → `:207` `app.use('/api', router)` → `:210` `trackRouter` → `:231` `notFoundHandler` → `:232` `errorHandler` |
| Notable deps | `helmet ^8`, `cors ^2.8.5` (`:129`, origin `env.MINI_APP_URL`, `credentials: true`), `compression`, `zod ^3.23.8`, `pino ^9.5.0`, `bullmq ^5.28.1`, `ioredis ^5.4.1` |
| `jsonwebtoken ^9.0.2` | Declared as a dependency but **imported by no file** (`grep -rln jsonwebtoken` → empty). Auth is Telegram-based, not JWT-based. |
| Scripts | `dev` = `tsx watch src/index.ts`; `build` = `tsc -p tsconfig.json`; **`start`** = `prisma migrate deploy … && node dist/index.js`; **`start:worker`** = `prisma migrate deploy … && node dist/workers/index.js`; aliases `start:api`, `worker`; `typecheck`, `lint` = `eslint src`; `test` = **integration** (`vitest run`, needs live Postgres); **`test:unit`** = DB-free (`vitest run --config vitest.unit.config.ts`) |

---

## 2. Database type

| Item | Value |
|---|---|
| Primary | **PostgreSQL** — `backend/prisma/schema.prisma:13-16`: `datasource db { provider = "postgresql"; url = env("DATABASE_URL") }` |
| Secondary | **Redis** — `ioredis`, wrapper `backend/src/db/redis.ts`; used for BullMQ, the admin session store, rate-limit buckets, cache |
| Connection clients | `backend/src/db/prisma.ts` (Prisma client singleton), `backend/src/db/redis.ts` (`redis`, `pingRedis`, cache helpers) |

---

## 3. ORM / database library

| Item | Value |
|---|---|
| ORM | **Prisma `^5.22.0`** — `@prisma/client` in deps, `prisma` CLI as devDependency |
| Generator | `schema.prisma:9-11` `generator client { provider = "prisma-client-js" }` |
| Generated client path | `node_modules/.prisma/client` (verified present) |
| Wrapper module | `backend/src/db/prisma.ts` |
| Raw SQL | `$queryRaw` in **14 files** — incl. `services/wallet.service.ts` (3), `services/analytics.service.ts` (3), `routes/admin/analyticsExtra.routes.ts` (4), `services/admin.service.ts` (2), `services/escrow.service.ts`, `services/deposit.service.ts`, `services/cpcBilling.service.ts`, `db/prisma.ts` |
| BigInt handling | `bigintSafeJson()` middleware (`app.ts:175`) — Prisma BigInt cannot be JSON-serialised directly |

---

## 4. Database schema / model files

| Item | Value |
|---|---|
| Schema file | **`backend/prisma/schema.prisma`** — the only `.prisma` file in the repo |
| Models | **41** |
| Enums | **39** |
| Seed | `backend/prisma/seed.ts` (wired via `prisma.seed` = `tsx prisma/seed.ts`) |

---

## 5. Migration system

| Item | Value |
|---|---|
| System | **Prisma Migrate** |
| Directory | `backend/prisma/migrations/` — **12 migrations** + `migration_lock.toml` |
| Lock provider | `migration_lock.toml` → `provider = "postgresql"` |
| Convention | **Hand-written SQL**, e.g. `20260929100000_add_channel_posting_schedule/migration.sql` is a plain `ALTER TABLE … ADD COLUMN … JSONB` with an explanatory comment. Note the non-CLI timestamps (many at `…100000`, `…120000`) — these were authored, not generated. |
| Migrations present | `20260926013109_init`, `20260926014049_withdrawal_review_flag`, `20260926022543_advertiser_api_webhooks_billing_security`, `20260926055316_add_deposit_payment_fees`, `20260926070234_add_crypto_deposit_addresses`, `20260926080332_add_stars_amount_to_deposits`, `20260926081458_seed_crypto_deposit_addresses`, `20260926093000_add_crypto_chain_transfers`, `20260926100000_harden_ledger_relations_and_job_sequence`, `20260926120000_channel_campaign_cap_nullable`, `20260927100000_reprice_monthly_plan_and_repair_terms`, `20260929100000_add_channel_posting_schedule` |
| Applied on boot | **`backend/src/db/migrate.ts`** → `runMigrationsOnBoot()` (called from `index.ts:6`); takes a **Postgres advisory lock**, so API and worker racing at boot is safe |
| Also applied by script | `start`, `start:api`, `start:worker`, `worker` all run `prisma migrate deploy` first |
| Deploy wiring | `render.yaml` — API `startCommand: npm run start:api` (`:67`), worker `startCommand: npm run start:worker` (`:139`) |
| Fragility | The `prisma` CLI is a **devDependency**; the scripts' own comment warns that if the build stops installing dev deps, migrations silently stop running. |

---

## 6. Authentication / authorization system

All middleware lives in `backend/src/middleware/`. Request typing: `backend/src/types/express.d.ts:3-5` (`declare global { namespace Express { interface Request … } }`), context types in `backend/src/types/auth.ts:20` (`RequestContext`).

| Mechanism | File | Exported symbols | How it authenticates |
|---|---|---|---|
| **Telegram Mini App** (primary) | `middleware/telegramAuth.ts` | `verifyInitData()` `:48`, `extractInitData()` `:117`, `telegramAuth(options)` `:141`, `optionalTelegramAuth()` `:206` | HMAC-SHA256 over sorted `key=value` lines, key derived from the bot token (`:15-18`); reads the `x-telegram-init-data` header; enforces a max length (`:53`); calls `trackSession` |
| **Staff panel session cookie** | `middleware/adminPanelAuth.ts` | `adminPanelAuth()` `:43`, `clearPanelSessionCookie()` `:111` | Cookie `bf_admin_sid` → Redis session record, **or** falls through to `telegramAuth()`. Enforces CSRF (`x-csrf-token`) for unsafe methods on the cookie path only. |
| **Admin gate** | `middleware/adminAuth.ts` | `ADMIN_PERMISSIONS` `:19`, `requireAdmin()` `:52`, `requireRole(...roles)` `:84`, `requirePermission(key)` `:102` | Re-reads the `AdminUser` row per request |
| **Advertiser API keys** | `middleware/apiKeyAuth.ts` | `requireScope(scope)` `:100` | `AdvertiserApiKey` + scopes |
| Rate limiting | `middleware/rateLimit.ts` | `rateLimit(options)` `:23`, `limiters` `:71` (includes `adminLogin`: 10 per IP / 15 min) | Fixed-window, Redis or in-process fallback |
| Validation | `middleware/validate.ts` | `validate(schemas)` `:16`, `bodyOf()` `:48` | zod, per `body` / `query` / `params` |
| Other | `middleware/maintenanceMode.ts` `maintenanceGuard()` `:17`; `middleware/errorHandler.ts` `notFoundHandler()` `:20`, `errorHandler()` `:37`, `mapPrismaError()` `:130`; `middleware/requestId.ts` `requestId()` `:11`, `clientIp()` `:35` | | |

---

## 7. Admin authentication and middleware

| Item | Value |
|---|---|
| **Login routes** | `backend/src/routes/admin/auth.routes.ts` — `adminAuthPublicRouter.get('/config')` `:104`, `adminAuthPublicRouter.post('/login')` `:124` → **`GET /api/admin/auth/config`**, **`POST /api/admin/auth/login`** |
| **Session routes** | same file — `adminAuthRouter.get('/me')` `:200`, `.post('/logout')` `:225`, `.get('/sessions')` `:237`, `.post('/sessions/revoke-all')` `:248` → **`/api/admin/auth/me`**, `/logout`, `/sessions`, `/sessions/revoke-all` |
| Acting identity | `backend/src/routes/admin/session.routes.ts` — `sessionRouter.get('/')` `:29` → **`GET /api/admin/session`** (role, `permissions[]`, `isSuperAdmin`, plus `session.active` / `session.csrf`) |
| Credential service | `backend/src/services/adminPanelAuth.service.ts` — `loginWithPassword()`, `identityFromAdminId()`, `isPanelLoginEnabled()` |
| Session store | `backend/src/services/adminSession.service.ts` — `createSession`, `readSession`, `destroySession`, `listSessions`, `destroyAllSessions`, `csrfMatches`; Redis key prefix `admin:sess:` (**sha256 of the session id**), plus an in-process fallback when Redis is not `ready` |
| Password hashing | `backend/src/utils/password.ts` — `hashPassword()`, `verifyPassword()` (scrypt, timing-safe), `safeEqual()`; generator script `backend/scripts/hash-admin-password.mjs` |
| **Router gate** | `backend/src/routes/admin/index.ts:48` `adminRouter.use('/auth', adminAuthPublicRouter)` (public) → `:50` **`adminRouter.use(adminPanelAuth(), requireAdmin(), limiters.admin)`** → `:54` `adminRouter.use('/auth', adminAuthRouter)` |
| Mount prefix | `app.ts:207` `app.use('/api', router)` + `routes/index.ts:76` `router.use('/admin', adminRouter)` → everything is under **`/api/admin`** |
| Admin route files | **26** in `backend/src/routes/admin/` (incl. `common.ts`, `analyticsExtra.helpers.ts`, `systemStatus.helpers.ts`, `__tests__/`) |
| Permission catalog | `ADMIN_PERMISSIONS` — **22 keys**: `dashboard.view`, `users.view`, `users.manage`, `users.balance.adjust`, `campaigns.view`, `campaigns.manage`, `channels.view`, `channels.manage`, `deposits.view`, `deposits.manage`, `withdrawals.view`, `withdrawals.manage`, `delivery.view`, `delivery.manage`, `fraud.view`, `fraud.manage`, `tickets.view`, `tickets.manage`, `settings.manage`, `admins.manage`, `audit.view`, `broadcast.send` |
| Admin roles | `AdminRole` enum — `SUPER_ADMIN`, `ADMIN`, `MODERATOR`, `FINANCE_MANAGER`, `SUPPORT_AGENT`, `ANALYST` |
| **Tables** | `admin_users` (`AdminUser`), `users` (`User`), `login_events` (`LoginEvent`) |
| Env config | `ADMIN_PANEL_USERNAME`, `ADMIN_PANEL_PASSWORD_HASH`, `ADMIN_PANEL_ADMIN_TELEGRAM_ID`, `ADMIN_PANEL_SESSION_TTL_HOURS`, `ADMIN_PANEL_SESSION_COOKIE` (`bf_admin_sid`), `ADMIN_PANEL_CSRF_COOKIE` (`bf_admin_csrf`), `ADMIN_PANEL_COOKIE_SECURE` — validated in `backend/src/config/env.ts` |

---

## 8. Ticket-related models and APIs

| Item | Value |
|---|---|
| **Model** | `SupportTicket` — `schema.prisma:1106`; **table `support_tickets`**; indexes `[status]`, `[userId]`; fields include `ticketNo`, `subject`, `category`, `status`, `priority`, `assignedToId`, `lastMessageAt`, `closedAt` |
| **Model** | `TicketMessage` — `schema.prisma:1131`; **table `ticket_messages`**; index `[ticketId, createdAt]`; fields `senderId`, `senderType`, `body`, **`attachmentUrl`**, `createdAt` |
| Enums | `TicketStatus` `:169`, `TicketPriority` `:177`, `TicketSenderType` `:184`, `TicketCategory` |
| **Service** | `backend/src/services/ticket.service.ts` |
| ↳ owner functions | `createTicket(userId, input)` `:71`, `listTickets(userId, p)` `:136`, **`getTicket(userId, ticketId)` `:164`** (owner-scoped — this is the admin 404), `addMessage(userId, ticketId, body)` `:189` |
| ↳ admin functions | `listTicketsAdmin(filter, p)` `:233`, `adminReplyTicket(adminId, ticketId, body)` `:260`, `setTicketStatus(adminId, ticketId, status)` `:297` |
| **User API routes** | `backend/src/routes/support.routes.ts` (mounted at `/api`, no prefix — `routes/index.ts:51`): `GET /api/support/tickets` `:29`, `POST /api/support/tickets` `:39`, **`GET /api/support/tickets/:id` `:54`**, `POST /api/support/tickets/:id/messages` `:64` |
| **Admin API routes** | `backend/src/routes/admin/support.routes.ts`, mounted `/api/admin/support`: `GET /api/admin/support/tickets` `:31` (`tickets.view`), `POST /api/admin/support/tickets/:id/reply` `:42` (`tickets.manage`), `POST /api/admin/support/tickets/:id/status` `:53` (`tickets.manage`) |
| **Missing** | **No admin-scoped thread read.** There is no `GET /api/admin/support/tickets/:id`. |
| Attachments | Already modelled (`TicketMessage.attachmentUrl`); no separate attachment table |

---

## 9. Notification / attention-feed implementation

| Item | Value |
|---|---|
| **Model** | `Notification` — `schema.prisma:1219`; **table `notifications`**; fields `userId`, `type`, `title`, `body`, `data Json?`, `link`, `isRead`, `readAt`, `delivered`, `sentAt`, `createdAt`; indexes `[userId, isRead]`, `[createdAt]` |
| Enum | `NotificationType` — **23 members** (incl. `SYSTEM`, `FRAUD_ALERT`, `SECURITY_ALERT`, `EARNINGS_AVAILABLE`) |
| **Service** | `backend/src/services/notification.service.ts` — `createNotification()` `:42`, `createBulkNotifications()` `:92`, `deliverToTelegram()` `:129`, `listNotifications()` `:193`, `countUnread()` `:222`, `markNotificationsRead()` `:226`, `markAllRead()` `:235`, **`alertAdmins(text)` `:251`** (Telegram-only, **writes no DB row**) |
| Alert service | `backend/src/services/alert.service.ts` — `checkBudgetAlerts()` `:54`, `notifyEarningsAvailable()` `:145`, `recordLoginAndAlert()` `:203`, `trackSession()` `:264`, `notifyWithdrawalRequested()` `:281` |
| **User API routes** | `backend/src/routes/notification.routes.ts`, mounted `/api` (`routes/index.ts:50`): `GET /api/notifications` `:35`, `POST /api/notifications/read` `:45`, `POST /api/notifications/read-all` `:61`, `GET /api/notifications/unread-count` `:72` |
| **Admin attention feed** | `backend/src/routes/admin/attention.routes.ts` — gate `attentionRouter.use(requirePermission('dashboard.view'))` `:28`; `attentionRouter.get('/')` `:171` → **`GET /api/admin/attention`**. Computed on read from **11 `count()` queries** (`:199-208` and following): pending deposits, withdrawals, `PENDING_REVIEW` campaigns, `PENDING` channels, creative versions, failed deliveries, fraud events, open reports, open tickets, crypto transfers, permissionless admins. **Stores nothing.** |
| Frontend | `frontend/src/pages/Notifications.tsx` (user inbox, routed); `frontend/src/admin/pages/Attention.tsx` (132 lines); `frontend/src/admin/components/TopBarTools.tsx` (`AttentionBell`, `GlobalSearch`, `Breadcrumb`) |
| Admin notification client | **None** — `grep -i notif` on `frontend/src/admin/lib/api.ts` → no functions; `grep -c "admin.*[Nn]otif"` on `queryClient.ts` → **0** |

---

## 10. Broadcast / job implementation

| Item | Value |
|---|---|
| Queue names | `backend/src/queues/names.ts` — `QUEUE_NAMES` (delivery, scheduler, permission, stats, payout, withdrawal, fraud, **notification**) and `JOB_NAMES` incl. **`SEND_TELEGRAM_NOTIFICATION: 'send-telegram-notification'` `:47`**, **`BROADCAST: 'send-broadcast'` `:53`** |
| Queues | `backend/src/queues/queue.ts` — `makeQueue()` `:35`; `deliveryQueue` `:47`, `schedulerQueue` `:56`, `permissionQueue` `:57`, `statsQueue` `:58`, `payoutQueue` `:59`, `withdrawalQueue` `:60`, `fraudQueue` `:61`, **`notificationQueue` `:62`** |
| **Producers** | `backend/src/queues/producers.ts` — `enqueuePublishAd()` `:29`, `enqueueRetryDelivery()` `:51`, `cancelDeliveryJob()` `:59`, `enqueueChannelPermissionCheck()` `:70`, `enqueueChannelStatsRefresh()` `:78`, `enqueueWithdrawalProcessing()` `:90`, **`enqueueNotification()` `:103`**, **`enqueueBroadcast()` `:134`**, `enqueueEmail()` `:162`, `enqueueWebhookDelivery()` `:192`, `emitWebhookEvent()` `:210` |
| Workers | `backend/src/workers/index.ts` (106) + one per domain: `delivery`, `notification`, `permission`, `payout`, `scheduler`, `stats`, `webhook`, `withdrawal`, `fraud`, `cleanup`, `registry.ts` |
| Broadcast worker | `backend/src/workers/notification.worker.ts` — handles `send-telegram-notification` (`:70`) and **`send-broadcast` (`:110`)** |
| **Admin API** | `backend/src/routes/admin/broadcast.routes.ts`, mounted `/api/admin/broadcast`: `BROADCAST_MAX_RECIPIENTS = 100` `:46`, `broadcastAudienceWhere()` `:59`, `GET /api/admin/broadcast/audience` `:110` (`broadcast.send`), `POST /api/admin/broadcast` (`broadcast.send`, `dryRun` supported) |
| Fan-out | `notification.service.createBulkNotifications()` `:92` — one `Notification` row + one `send-telegram-notification` job **per recipient** |
| **Database models** | **No broadcast model of any kind.** Models whose name contains *Delivery* or *Notification*: `DeliveryJob` `:922`, `Notification` `:1219`, `ChannelDeliveryLog` `:1264`, `DeliveryEvent` `:1360`, `WebhookDelivery` `:1755`. **No `BroadcastJob`, no `BroadcastRecipient`, no table for per-recipient delivery state.** The only per-recipient artefact is the `Notification` row (`delivered` boolean + `sentAt`) — it does not record the Telegram message id, the failure reason, or which broadcast produced it. |

---

## 11. Settings model and `updateSettingSchema`

| Item | Value |
|---|---|
| **Model** | `Setting` — `schema.prisma:1246`; **table `settings`**; index `[group]` |
| Fields | `id`, **`key String @unique`**, **`value Json`**, **`valueType String @default("string")` (`@map("value_type")`, comment `string \| int \| bool \| json`)**, `group String @default("general")`, `description`, `isPublic`, `updatedById`, `createdAt`, `updatedAt` |
| **`updateSettingSchema`** | **`shared/src/schemas.ts:211-214`** — `z.object({ key: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown())]) })`. **There is no array member** — `z.record` accepts an object, and zod rejects an array for it, so an array value fails validation before Prisma is reached. |
| Defaults / key registry | `backend/src/config/constants.ts` — `SETTING_KEYS` `:9`, `SETTING_DEFAULTS` `:157` (**21 keys**) |
| The three array-valued keys | `MIN_WITHDRAWAL_METHODS: 'allowed_withdrawal_methods'` `:84`; `ALLOWED_DEPOSIT_METHODS: 'allowed_deposit_methods'` `:85`; `BUDGET_ALERT_THRESHOLDS: 'budget_alert_thresholds'` `:103` |
| **Service** | `backend/src/services/settings.service.ts` — `getAllSettings(useCache)` `:21`, `getSetting()` `:35`, `getNumberSetting()` `:40`, `getBoolSetting()` `:46`, `getStringSetting()` `:53`, **`getArraySetting<T>()` `:59`** (an array reader already exists), `setSetting()` `:64`, `invalidateSettingsCache()` `:97`, `getPublicSettings()` `:122` |
| **Admin API** | `backend/src/routes/admin/settings.routes.ts`, mounted `/api/admin/settings`: `GET /` `:25` (`settings.manage`), **`POST /` `:35`** (`settings.manage` + `validate({ body: updateSettingSchema })`), `GET /audit-logs` `:46` (`audit.view`) |
| Frontend | `frontend/src/admin/pages/Settings.tsx` (336 lines); `frontend/src/admin/pages/settings/SettingsRow.tsx`, `SettingsSectionPage.tsx`, `sections.ts` |
| Current UI for arrays | Rendered **read-only** with the reason shown (the array settings cannot be submitted through the current schema) |

---

## 12. Admin frontend files for the four features

| Layer | Files |
|---|---|
| `frontend/src/admin/lib/` | `api.ts`, `types.ts`, `permissions.ts`, `actions.ts`, `session.tsx` |
| `frontend/src/admin/components/` | `AdminShell.tsx`, `ConfirmDialog.tsx`, `DataTable.tsx`, `Kpi.tsx`, `ListFilters.tsx`, `Pager.tsx`, `RowActions.tsx`, `StateBlock.tsx`, `TopBarTools.tsx` |
| Pages | `Support.tsx` (294), `Broadcast.tsx` (281), `Refunds.tsx` (318), `Attention.tsx` (132), `BlockedChannels.tsx` (321), `BlockedAds.tsx` (281), `Settings.tsx` (336), plus `pages/settings/` |
| User-facing counterparts | `frontend/src/pages/Notifications.tsx`, `frontend/src/pages/Support.tsx` |

**Client functions per feature** (from `frontend/src/admin/lib/api.ts`):

| Feature | Functions present | Gap |
|---|---|---|
| Ticket thread | `listTickets`, `replyTicket`, `setTicketStatus` | **no thread-read function** |
| Broadcast | `getBroadcastAudience`, `sendBroadcast` | **no history, detail or recipient-list function** |
| Refund | `createRefund` | — |
| Attention feed | `getAttentionFeed` | — |
| **Admin notifications** | *(none)* | **no client functions and no query keys at all** |

---

## Summary of what the four planned steps actually face

| Step | Reality |
|---|---|
| 3 — Admin ticket thread | One missing read path. `TicketMessage.attachmentUrl` already exists. **No migration needed.** |
| 4 — Persistent notification inbox | **Already built** for users (model, read state, pagination, 4 routes, an inbox screen, 12 call sites). What is missing is an **admin** inbox; `alertAdmins()` writes no DB row. An admin is a `User`, so this needs **no migration**. |
| 5 — Broadcast delivery report | **No broadcast model exists.** Per-recipient state lives only as `Notification.delivered` / `sentAt`. Needs a schema change; I cannot apply a migration from this workspace (no `.env`, no `DATABASE_URL`). |
| 6 — Array settings | Validation-only failure; `Setting.value` is already `Json` with a `json` value type and `getArraySetting()` already reads them. **No migration needed.** |

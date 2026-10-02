# BotFlow Ads Admin Panel — Build Progress

Living document. Maps the 88-section specification to what exists, round by round.
Companion documents:
- `ADMIN-PANEL-REPORT.md` — the panel as first delivered (24 screens) and how it was verified
- `ADMIN-PANEL-SPEC-GAP-ANALYSIS.md` — every spec section checked against the codebase

Base commit: `3449716`. **Nothing has been committed or pushed.**

---

## Decisions applied (from the owner)

| Spec | Decision | Effect |
|---|---|---|
| §4 / §70 login | Username + password. **No 2FA, no session store, no CSRF token.** | Implemented as specified — see "What that means" below. |
| §62 permission names | Keep the code's existing 22 keys; spec names are labels only. | No guard rewrites, no permission-array migration. |
| Work order | Backend gaps first. | This round. |

---

## Round 1 — delivered

### 1. Staff panel login (§4) — new

Username and password are set by the operator and appear in **neither the repository nor this
document** — the password exists only as a scrypt hash in an environment variable. Setup:

```bash
cd <repo>
node backend/scripts/hash-admin-password.mjs      # type the password at the prompt
```

Then add all three lines to `.env` (gitignored) — plus the optional signing key:

```
ADMIN_PANEL_USERNAME=<your panel username>
ADMIN_PANEL_PASSWORD_HASH=<the hash the script prints>
ADMIN_PANEL_ADMIN_TELEGRAM_ID=<your numeric Telegram id>
ADMIN_PANEL_TOKEN_SECRET=<a long random string>   # optional but recommended
ADMIN_PANEL_TOKEN_TTL_HOURS=12
```

`ADMIN_PANEL_ADMIN_TELEGRAM_ID` is the account every panel action is attributed to in
the audit log. It must have opened the bot once. Nothing else in the codebase creates
an `AdminUser` row, so the first successful login creates one as SUPER_ADMIN and logs
a warning — that is the one-time bootstrap.

**Endpoints**

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/admin/auth/config` | none | whether the password door is configured |
| POST | `/api/admin/auth/login` | none | `{ username, password }` → `{ token, expiresAt, admin, user }` |
| GET | `/api/admin/auth/me` | required | the acting identity |
| POST | `/api/admin/auth/logout` | required | no-op by design (stateless token) |

**Files**: `backend/src/utils/password.ts` (scrypt + timing-safe compare),
`backend/src/services/adminPanelAuth.service.ts` (credential check + signed token),
`backend/src/middleware/adminPanelAuth.ts` (the one gate for `/api/admin`),
`backend/src/routes/admin/auth.routes.ts`, `backend/scripts/hash-admin-password.mjs`,
`frontend/src/lib/adminToken.ts`, `frontend/src/admin/pages/Login.tsx`.

Telegram initData still works, unchanged — this is an **additional** door, so a broken
password login cannot lock an operator out. `adminPanelAuth()` accepts either
credential and converges both on the same `req.user`, so no existing admin route changed.

### What the "no 2FA / no session / no CSRF" decision actually means

Each omission was implemented deliberately, and each has a property worth knowing:

- **No session store** — the credential is exchanged once for a signed, self-expiring
  (12h) token. There is nothing to revoke, so revocation works the other way: the API
  re-reads the `AdminUser` row on **every** request, so deactivating an admin ends their
  access instantly even while the token is still valid. That is stronger than a
  revocable session, not weaker.
- **No CSRF token** — there is no cookie. Auth rides an explicit `x-admin-token`
  header, which a cross-site form post cannot set. The protection is architectural;
  adding a CSRF token would be theatre.
- **No 2FA** — a single factor guarding every financial control in the product.
  Compensating controls that ARE in place: scrypt hashing (never a plaintext or fast
  hash), the secret only ever in `.env` and never in the repo, timing-safe comparison,
  an identical error for a wrong username and a wrong password, and a deliberately
  hostile rate limit of **10 attempts per IP per 15 minutes** on the login route.
  A password-manager-generated secret would close the remaining gap.

### 2. User moderation (§9, §10, §45) — new

`UserStatus` already had `SUSPENDED`/`BANNED` and `User.suspendedReason`, but **no route
anywhere set them** — an admin could not suspend or ban anyone.

| Method | Path | Permission |
|---|---|---|
| POST | `/api/admin/users/:id/suspend` | `users.manage` |
| POST | `/api/admin/users/:id/unsuspend` | `users.manage` |
| POST | `/api/admin/users/:id/ban` | `users.manage` |
| POST | `/api/admin/users/:id/unban` | `users.manage` |

Reason is mandatory (3–500 chars) for suspend/ban. Guards: an admin cannot moderate
their own account; an active admin account cannot be suspended or banned unless the
actor is SUPER_ADMIN; the operations are idempotent; every real transition writes an
`AuditLog` row with old/new value and ip/userAgent. Enforcement is automatic —
`middleware/telegramAuth.ts` already rejects `BANNED`/`SUSPENDED` users with a 403
across the whole API. It deliberately touches no money: escrow and open campaigns of a
moderated user are left for a separate decision.

### 3. CSV exports (§78) — new

`GET /api/admin/export/{users,channels,campaigns,transactions,deposits,withdrawals,earnings,revenue}.csv`
Each gated by the matching `.view` permission, honouring the same filters as its list
endpoint. Hard cap 50,000 rows with an explicit truncation line (never silent), streamed
in batches of 1,000, RFC 4180 quoting, UTF-8 BOM for Excel, and **CSV formula-injection
neutralised** (a cell starting with `=` `+` `-` `@` TAB CR is prefixed with a quote).
BigInt columns are stringified (a raw BigInt in a template literal throws). One audit row
per export. Files: `backend/src/utils/csv.ts`, `backend/src/routes/admin/export.routes.ts`.

### 4. `AdminUser.permissions` is now writable (§61, §62) — fixed

`PATCH /api/admin/admin-users/:id` accepts `permissions`, validated against the 22-key
catalogue. An unknown key is a 400 naming it — never a silent drop, because a typo that
disappears is how someone ends up with access nobody intended. A `permissions` array on a
SUPER_ADMIN row is refused with an explanation (SUPER_ADMIN bypasses the checks, so a
stored list would look like a restriction that is never applied). This was the one thing
blocking end-to-end role management: before it, a newly granted non-SUPER_ADMIN admin had
an empty permission list, which `requirePermission` reads as "denied".

### 5. Global search (§64) — new

`GET /api/admin/search?q=&limit=` across users (username / first / last / Telegram id),
channels, campaigns, transactions and tickets. Returns one flat shape with a panel `href`
per hit, so the top bar can render it without per-type logic. Each entity is capped, runs
in parallel via `Promise.allSettled` (one failure does not fail the search), and the code
documents that a leading-wildcard `LIKE` cannot use a B-tree index — scaling needs
pg_trgm or a tsvector index, not a bigger `take`.

---

## Round 2 — session store + CSRF, then the next gaps

### 6. The auth design changed: real sessions + CSRF (§4 revisited)

Round 1's stateless signed token is **gone**. Per instruction, the panel now has a
server-side session store and CSRF protection (2FA stays out).

| Piece | How it works |
|---|---|
| Session id | 32 random bytes in an **HttpOnly** cookie (`bf_admin_sid`), so XSS on the origin cannot read it — strictly better than the localStorage token it replaced. |
| Session record | Redis key `admin:sess:<sha256(id)>` → `{ adminId, csrf, createdAt, ip, userAgent }`, TTL 12h, **sliding** (refreshed on use). |
| Why the key is hashed | The value the browser holds and the value Redis holds are different strings, so a leaked Redis dump or snapshot cannot be replayed as a live session. |
| CSRF | The expected value lives **in the session record**, not in the second cookie. Plain double-submit is defeated by anyone who can write a cookie on the registrable domain (subdomain takeover, sibling app); a server-held secret is not. Compared with `timingSafeEqual`. |
| Scope | Enforced **only** for the cookie door and only for unsafe methods. The Telegram path is header-carried and structurally immune, so demanding a token there would add a failure mode without adding protection. |
| Login CSRF | Also covered: `GET /auth/config` seeds a pre-session cookie and `POST /auth/login` requires it, then **rotates** the value into the session — which kills session fixation. |
| Revocation | Sessions are real records: `GET /auth/sessions` lists them (fingerprint, ip, user agent) and `POST /auth/sessions/revoke-all` kills them. Independently, the admin row is re-read per request, so deactivating an admin ends access immediately. |
| No session store? | If Redis is not `ready`, sessions fall back to an in-process map with a loud log. They then die with the process and are not shared between instances — fine for a single instance, a hard limit on more. |
| Cookie flags | `HttpOnly` (session id only), `Secure` (forced on in production — `env.ts` refuses to boot otherwise), `SameSite=Strict`, `Path=/`. |

`ADMIN_PANEL_COOKIE_SECURE` must be `true` in production; `false` is only for local http
development, and the hardening check makes that explicit rather than silent.

### 7. Analytics aggregates + system status board (§7, §27, §28, §39–42, §83)

`GET /api/admin/analytics/{campaigns,delivery,users,channels,funnel}` — the panel had no
source for any of these; revenue-by-day was the only aggregate. All `groupBy`/`aggregate`
(no row scans), `days` clamped to 1…366, every BigInt converted, and each aggregation
carries a note on what index it would need at scale.

`GET /api/admin/system` — a status board for `api`, `database`, `redis`, `queues`,
`telegramBot`, `webhook`, each `ONLINE | DEGRADED | OFFLINE | UNKNOWN`. Every probe is
individually caught and 2s-timeout-raced, so one dead dependency yields one UNKNOWN tile
instead of a 500. The bot probe reads the **cached** identity rather than calling
Telegram — a status page that can rate-limit the bot is worse than an honest UNKNOWN.

### 8. Date-range and sorting on the large lists (§79)

`from` / `to` / `sort` added to seven list endpoints (deposits, withdrawals, transactions,
users, campaigns, channels, delivery). All optional: a request sending none behaves
exactly as before, which the tests assert per endpoint.

The security-relevant part: `sort` is a `z.enum` of that endpoint's own keys, mapped to an
explicit Prisma `orderBy` inside an exhaustive `switch`. A client string never reaches
`orderBy`, and an unlisted value is a compile error. `from` is inclusive (`gte`), `to` is
exclusive (`lt`), and `from > to` is a 400 with a readable message. Each endpoint filters
the date on **its own** timestamp column — notably delivery uses `scheduledAt`, not
`createdAt`, because that is the column it orders by. Default ordering is preserved
everywhere; changing it silently would reorder everybody's view.

### 9. Settings split into sub-pages (§53–60)

`/admin/settings/:section` renders one of ten named sections (General, Advertising,
Publisher, Advertiser, Payments, Withdrawals, Referrals, Notifications, Telegram,
Maintenance) plus an "Other" catch-all. `/admin/settings` stays as the grouped,
searchable everything-view.

The row editor is copied from the existing screen rather than re-implemented, so the
type-preserving save logic cannot diverge. All the Round-1 honesty rules survive: array
settings stay read-only with the reason, a null-defaulted setting still cannot be cleared
back to null, saves stay per-key.

The section predicates are asserted to be a **disjoint partition** of the real key set by
`frontend/src/test/settingsSections.test.ts`, which imports `SETTING_DEFAULTS` directly.
The first draft of the section module imported that backend file at runtime — which would
have dragged server modules into the browser bundle. It now transcribes the keys and keeps
the cross-package import in the test only; the build is verified to contain no
`SETTING_DEFAULTS`.

### Verification after Round 2

| Check | Result |
|---|---|
| Frontend typecheck | **clean** |
| Backend typecheck | **clean** |
| Backend lint | **clean** |
| Backend unit tests | **135 pass** (was 58) |
| Frontend tests | **44 pass** (was 37) |
| Frontend build | **1084 modules, 6.25s** |
| Admin chunk | 167 kB / 41.8 kB gzip — separate from the 974 kB app chunk |
| Client bundle | no backend constants leaked |

Two real bugs were caught by these tests rather than by review:

1. **`destroyAllSessions` had the comparison inverted** in its in-memory path — "sign out
   everywhere" was deleting *other* admins' sessions and keeping the caller's.
2. **`listSessions` returned insertion order in the memory path** but newest-first on the
   Redis path, so the two backends disagreed. Found by another workstream's agent while
   running the shared suite, and fixed to match.

Total admin endpoints now: **51 in `routes/admin/` + 16 ops + 1 health probe = 68**.

---

## Round 3 — the remaining Round 2 wiring, then the next gaps

### 10. Round 2's backend finally has a UI

The Round 2 endpoints shipped with no way to reach them. Now:

| Screen | Route | What it shows |
|---|---|---|
| Breakdowns | `/admin/analytics/breakdown` | campaign/delivery/channel/user-growth aggregates, plus the §86 funnel as an ordered step list with drop-off between steps |
| System status | `/admin/system` | api / database / redis / queues / telegramBot / webhook, each `ONLINE · DEGRADED · OFFLINE · UNKNOWN` as text **and** colour, refreshing every 30s with the interval stated on screen |
| Needs attention | `/admin/attention` | the computed feed, grouped by severity |
| List filters | all seven large tables | `from` / `to` / `sort`, in the URL like the existing filters |

Two implementation notes worth keeping:

- **The funnel is not monotonic and the UI says so.** A step larger than its predecessor is
  flagged rather than clamped to 0% drop-off, because a "funnel" whose counts go up is not a
  funnel — the honest response is to label it, not to hide it.
- **`to` is exclusive, so the date control shifts the end day.** A bare `YYYY-MM-DD` from a
  date input is midnight UTC; sending it unchanged as an exclusive bound would silently drop
  the entire day the operator selected. The filter sends `to + 1 day`.

### 11. Blocked channels / ad posts (§46–48)

`/api/admin/blocked/{channels,ads}` plus the two screens, all `fraud.manage`.

The honest part, stated in the UI and not just in code comments:

- There is **no blocked-ads table**, and `AdPostStatus` has **no `REMOVED` member** — only
  `DELETED` and `REJECTED`. So "blocked ads" means "not deliverable": DELETED/REJECTED posts
  **plus** posts whose channel is on the blocklist. `reason` is **derived** server-side
  (admin-block marker → moderation → status → channel block), not a stored status.
- Blocking sets the post to DELETED and stamps `BLOCKED_BY_ADMIN:<reason>` into the post's
  `errorMessage` column, writing an `AD_POST_BLOCKED` audit row — **the audit row is the
  authoritative record**. Unblocking restores the prior status **read from that audit row**
  and deliberately refuses to reverse a genuine moderation removal.
- **`PublisherBlocklist` is not what the spec (and my own gap analysis) assumed.** It is
  per-channel, scoped `ADVERTISER | CAMPAIGN | CATEGORY | DOMAIN`, keyed on
  `(channelId, scope, value)`, with **`label` and no `reason` column**. The routes use the
  model as it actually is and map `label` ↔ `reason` on the wire. The gap-analysis document
  has been corrected — a stale claim in my own analysis was the origin of that mismatch.

### 12. Needs-attention feed (§52, §65)

`GET /api/admin/attention` — eleven counts (pending deposits/withdrawals, campaigns and
channels awaiting review, creative versions awaiting review, failed deliveries, unresolved
fraud events, open reports, open tickets, crypto transfers awaiting a credit, admin accounts
with an empty permission list), run with `Promise.all`, sorted by severity, each with a real
panel `href`.

**This is a computed view, not a notification centre**, and both the code and the UI say so:
one count query per source per request, nothing stored, nothing markable as read. Calling it
an inbox would promise persistence it does not have. The route comment names the cost and what
would be needed at scale (a materialised view or a cached snapshot).

### 13. Top bar and navigation

- **Cross-entity global search** in the top bar (§64), debounced, min 2 characters (the server
  rejects shorter), dropdown with per-type labels, closing on outside click.
- **Attention bell** with an urgent count (CRITICAL + HIGH summed), refreshing every 60s. The
  accessible label says it is a live count and not a message inbox.
- **Breadcrumbs** (§81) — `Admin › <nav group> › <screen>`.
- **Sidebar** gained the Round 3 screens; the settings page gained a sub-nav of its ten
  sections so they are reachable without typing a URL.

### Verification after Round 3

| Check | Result |
|---|---|
| Frontend typecheck | **clean** |
| Backend typecheck | **clean** |
| Backend lint | **clean** |
| Backend unit tests | **143 pass** |
| Frontend tests | **56 pass** |
| Frontend build | **1091 modules, 6.35s** |
| Chunks | admin 204 kB / 49.8 kB gzip — separate from the app chunk (956 kB / 274.6 kB) |
| Admin endpoints | **52 + 16 ops + 1 health = 69** |
| Screens | **30 page files**, 38 admin routes |

### Still open

1. **Admin-initiated refund (§38)** — refunds exist as ledger rows created by cancel flows; there is still no admin control to issue one.
2. **Broadcast producer** — the `broadcast.send` permission and the `broadcast-admin-alert` worker both exist, but nothing enqueues the job. Until a producer exists the permission is decorative.
3. **Publisher / advertiser list screens (§11, §12)** — need `isPublisher` / `isAdvertiser` filter params on the users list first; today those relationships are only visible inside a user's dossier.
4. **Sidebar sub-menus as nested nav entries (§8)** — the spec lists `Users → All / Advertisers / Publishers / Suspended / Banned`. Today those are in-page filters (and status ones are now URL-backed). Deliberately deferred until item 3 lands, so the sub-items would be truthful.
5. ~~**Standalone per-campaign / per-channel analytics screens (§40, §41)**~~ — done in Round 4, see below.

---

## Round 4 — the last of the open list

### 14. Corrected endpoint count

Earlier rounds of this document said "69 admin endpoints". That was **wrong**, and the
error was mine: the `grep` used to count them only matched single-line
`router.get('/path', …)` declarations, so every route whose path sat on the following
line was silently skipped. Recounted by matching the method-call start instead:

| | |
|---|---|
| `routes/admin/*` | **86** |
| `/api/admin/ops` (policy.routes.ts) | 16 |
| `/health/queues` | 1 |
| **Total** | **103** |

The spec's own §68 example list names 36.

### 15. Admin refunds (§38) — `POST /api/admin/finance/refunds`

`deposits.manage`. Draws from the campaign's held escrow **through the ledger** (a
`REFUND` transaction with its own reference) — never a direct wallet write, so the ledger
stays the source of truth. Five rules, all server-side:

- The refundable maximum is `max(0, min(reserved, total − spent − alreadyRefunded))`, read
  from the ledger. An over-ask is **refused with a 400 naming the maximum** — not clamped,
  because clamping hides that the operator asked for something impossible.
- `reference = refund:admin:<campaignId>:<n>` — a per-campaign sequence plus the unique
  `Transaction.reference` index, and `SELECT … FOR UPDATE` on the campaign so two concurrent
  refunds cannot both claim the same headroom.
- The reason (10–500 chars) lands in the **audit row**, which is the only durable record of
  why a credit was issued.
- `newBalanceCents` is re-read after the transaction, not computed from a pre-commit value.
- The screen deliberately does **not** duplicate the cap: it would drift, since the cap
  depends on escrow state the client cannot see. It surfaces the server's message verbatim.

### 16. Broadcast (§52) — and what the investigation found

`broadcast.send` was one of the 22 permission keys and **no code anywhere read it** — it was
decorative. Investigating it produced the most useful finding of this round:

- `broadcast-admin-alert` is an **admin-only** path: its handler sends to
  `TELEGRAM_ADMIN_IDS`, with no recipient list. It cannot carry a user broadcast.
- But `notification.service.createBulkNotifications()` **did** exist — it persists an in-app
  `Notification` per user and enqueues one `send-telegram-notification` job each. It had
  **zero callers**. That was the half-built state.

So the broadcast was built on that existing path rather than a new queue: one `send-broadcast`
job on the same `botflow-notification` queue, expanded per user by the worker. `GET /audience`
reports the true recipient count (PUBLISHERS/ADVERTISERS derived from relationships, as with
the users list); the hard cap is 100 and an over-limit send is **refused with the count and
the limit named**, never truncated — a partial blast reported as reaching everyone, with no
record of who was skipped, is worse than a refusal. `dryRun: true` counts and validates
without enqueueing, which is what the two-step confirmation uses.

### 17. Per-entity analytics (§40, §41)

`GET /api/admin/analytics/campaigns/:id` and `…/channels/:id`, `dashboard.view`.

Two details that would otherwise be quietly wrong:

- **A zero denominator yields `null`, not `0`.** `successRatePct` is null when nothing ran;
  `ctrPct` is null when there are no impressions. A "0%" that actually means "no data" is a
  fabricated measurement. A genuine 0 over real data still returns `0`.
- **Impressions are a real `Impression` count**, not a stand-in for views or reach. Those rows
  are written only by the CPM payout path, so a fixed-price campaign legitimately has none
  (§44).
- The distinct channel count comes from `DeliveryJob` grouped by channel — `CampaignTarget`
  would miss auto-targeting, `AdPost` would miss channels that were targeted but never
  delivered.

### 18. Publisher / advertiser screens (§11, §12) and the nested sidebar (§8)

`/admin/publishers` and `/admin/advertisers`, filtered by the relationship-derived
`isPublisher` / `isAdvertiser` parameters, with a URL-backed status filter beside the search
and the shared date/sort bar.

Membership is derived, and both screens **say so on screen**: a publisher is "a user with at
least one channel", so someone can appear or disappear from this list the moment their first
channel is added or removed. Both screens also omit the columns the API genuinely does not
return (per-user channel counts, subscriber totals, campaign counts) rather than computing a
total from one page of twenty and presenting it as the user's total.

The sidebar now has **28 nested sub-entries** across Users, Campaigns and Channels. They are
plain `Link`s, not `NavLink`s, because several differ only by query string
(`/admin/users?status=BANNED`) and `NavLink`'s `isActive` ignores the search string — using it
would light up every sibling at once. Each child points at a filter the backend really
accepts, so none of them lands on an unfiltered list while claiming to be a filtered view.

### Verification after Round 4

| Check | Result |
|---|---|
| Frontend typecheck | **clean** |
| Backend typecheck | **clean** |
| Backend lint | **clean** |
| Backend unit tests | **180 pass** |
| Frontend tests | **60 pass** |
| Frontend build | **1095 modules, 6.35s** |
| Chunks | admin 224 kB / 54.0 kB gzip — separate from the app chunk (956 kB / 274.7 kB) |
| Admin endpoints | **103** (corrected, see §14) |
| Screens | **34 page files, 34 admin routes, 45 nav entries** |

### Remaining

1. **Ticket message thread for staff (§50)** — blocked on the API: the only route returning
   ticket messages is owner-scoped, so an admin gets a 404. Needs an admin-scoped
   `GET /admin/support/tickets/:id`.
2. **Stored admin notification inbox (§52)** — the needs-attention feed is computed, not
   stored. A persistent per-admin inbox with read state would need a model, and therefore a
   migration.
3. **Broadcast delivery reporting** — a send returns a job id; there is no per-recipient
   delivery report or broadcast history endpoint, and the screen says so.
4. **Array-valued settings (§53–60)** — still read-only, because `updateSettingSchema` rejects
   arrays. Three settings remain database-only.

---

## Verification (this round, all run locally)

| Check | Before | Now |
|---|---|---|
| Backend typecheck (`tsc --noEmit`) | clean | **clean** |
| Backend lint (`eslint src`) | clean | **clean** |
| Backend unit tests | 7 | **58 pass** |
| Frontend typecheck | clean | **clean** |
| Frontend tests | 33 | **37 pass** |
| Frontend build | ✓ | **✓ 1081 modules, 6.28s** |
| Backend build | ✓ | **✓** |

New tests added (51): password hashing round-trip and every fail-closed case (a
malformed stored hash must deny, never allow), token forgery (tampered payload, tampered
signature, rotated secret, expired), user-moderation guards, CSV injection + escaping,
and permission-key validation.

Credential path checked against the built code: the configured username matches, the configured
password verifies against its hash, and both a wrong password and a wrong username are rejected.
(The literal values are deliberately not recorded here — they were supplied out of band.)

Bundle split re-verified: every admin-only string is in the panel chunk
(157 kB / 39 kB gzip); the main chunk (974 kB / 282 kB gzip) holds only the route
declarations. The Mini App's initial download is unchanged.

---

## Still open (from `ADMIN-PANEL-SPEC-GAP-ANALYSIS.md`)

Needs new backend work:

1. **Admin notification centre** (§52) — notifications are user-scoped only; no admin feed.
2. **Blocked ads / blocked channels lists** (§46–48) — `PublisherBlocklist` exists with no admin endpoint; there is no "blocked ads" entity.
3. **Bot / webhook / worker / error-log monitoring** (§27, §28, §83, §84)
4. **Analytics aggregates** (§7, §39–42) — campaign-status, delivery and user-growth charts.
5. **Sorting + date-range filters** on the large tables (§79).
6. **Admin refund action** (§38) — refunds exist as ledger rows created by cancel flows.
7. **Activity monitor** (§65) — composable from `/admin/ops/delivery/events/recent` + the audit log.
8. **A broadcast producer** — the `broadcast.send` permission and the
   `broadcast-admin-alert` worker exist, but nothing enqueues the job.

Frontend-only:

9. **Sidebar sub-menus** (§8) — `Users → All / Advertisers / Publishers / Suspended / Banned` as nav entries (the two new statuses are now filterable thanks to §2 above).
10. **Settings split into 10 named sub-pages** (§53–60) — today one grouped, searchable screen.
11. **Publisher / advertiser / analytics sub-screens** (§11, §12, §39–42).
12. **Breadcrumbs, notification bell, system-status widget** (§81, §83).

---

## Nothing pushed

`HEAD` = `origin/main` = `3449716`; 0 commits ahead. All work is in the working tree.
11 tracked files modified, and the round's new files are untracked.

# STATE.md — UserPlatform Checkpoint

## Current Checkpoint: GAUNTLET 1 — SERVICE BRIDGE READY (UserPlatform side only)

**Date:** 2026-09-20
**Repository:** `Llayon/UserPlatform`, branch `master`
**Starting HEAD:** `5f6d82c` (verified `git log`, clean tree, up to date)

### Gauntlet 1 contents (done, verified — Holodilnik NOT touched)

- Migration `20260920000000_service_bridge` applied remotely (local == remote):
  `service_credentials` (per-app, hash-only, RESTRICT on app delete) +
  `sessions(session_type, app_id)` with account/app CHECK; legacy rows default
  to `account` (production sessions survive).
- Service auth: `ups_<keyId>_<secret>` (hex, 256-bit secret, SHA-256 +
  timingSafeEqual), `ServicePrincipal{credentialId,appId,appSlug}` from DB
  mapping only; global `PLATFORM_SERVICE_TOKEN(_PREVIOUS)` removed everywhere.
- Sessions: `SessionPrincipal{userId,sessionId,sessionType,appId}`; account
  sessions read-only (403 on credit routes); app sessions only via
  `POST /v1/service/auth/platform-exchange` (raw token server-only, no cookie).
- Credits: `SERVICE==SESSION==OPERATION` on reserve + (user AND app) ownership
  on commit/release (registry `app_id` authoritative, never prefix checks).
- Client: `ServerPlatformClient` (`/server`) with
  `serviceAuth.exchangePlatform` + credits; browser client unchanged + pinned
  to never return raw tokens. Operator CLI
  `service:create|list|revoke|rotate` (token-once, list-safe).
- Tests: 121 fast + 10 pg-core + 4 engine-race + 1 exchange-race + 2 bridge-live
  all green; 11 bridge attack tests + 5 db-parity + 4 credential unit tests new.
  Docs: README destaled, `docs/service-bridge.md` + ADR-013/014 + F-004/F-005.
- Live smoke (post-migrate): gated suites green against Supabase; Vercel deploy
  is Phase 7 below (Preview then Production with the §45 smoke matrix).

## Previous Checkpoint: PHASE 6 — DEPLOYMENT (USER PLATFORM CORE READY)

**Date:** 2026-09-19
**Repository:** `Llayon/UserPlatform` (public, `origin/master` tracking)
**Branch:** master

### Phase 1 contents (done, pushed)

- `packages/db`: row types, `DbExecutor`/`Db` seam, 10 repository interfaces,
  `pg` adapter (sole driver owner), memory fakes with identical constraint
  semantics, unit tests (10) + `DATABASE_URL`-gated integration tests (9:
  seeds, cascade, unique/CHECK violations, 10-way identity race, idempotency,
  rollback, commit race, usage/entitlements).
- Critic closed: 1 BLOCKER (root tsconfig skipped db) + 3 P2 — see CRITIC.md.
- Tests: 42 pass, 9 integration skip without `DATABASE_URL` (by design).
  To run them locally: create `.env.local` with `DATABASE_URL` (dashboard →
  Connect → Direct connection URI, password substituted; never paste in chat).

### Live DB verification (2026-09-19, pooler URL, `npm run test`)

- Full suite **51/51 green** against live Supabase Postgres, including:
  - 10 parallel same-identity inserts → exactly 1 wins, 9 `DbConflictError`
  - concurrent commit transitions → exactly 1 wins
  - rollback discards partial writes; reservation/ledger idempotency holds;
    cascade delete verified; seeds exact.
- Connection note (F-001): direct `db.<ref>:5432` is IPv6-blackholed from
  this network; tests use the transaction pooler
  `aws-0-us-east-1.pooler.supabase.com:6543` (IPv4, BEGIN/COMMIT confirmed
  working). Gated tests carry an explicit 30s timeout (pooler latency).
- Post-run check: 0 leftover `itest-` identities (cascade cleanup works).

### Phase 2 contents (done, pushed)

### Phase 2 contents (done, pushed)

- Exchange service (`apps/api/src/services/exchange.ts`): signature validation
  (telegram/max), single-tx signup-or-login, welcome +10 (ledger-idempotent),
  acquisition first-seen, fresh session per exchange, race retry-once as login.
- HTTP: `POST /v1/auth/platform/exchange`, `POST /v1/auth/dev/exchange`
  (gated, 404 in prod), `DELETE /v1/auth/session`, `GET /v1/me`
  (cookie-bound, no user params). App factory injects db/repos (memory in
  tests, pg in prod). Migration `20260919190000_acquisitions.sql` applied.
- Critic closed: 2 P1 (fabricated createdAt, IDOR proof) — see CRITIC.md.
- Tests: **71/71**, incl. live 10-way exchange race (1 user, 1 bonus) and
  agent A/B isolation. `.env.example` gains TELEGRAM/MAX_BOT_TOKEN,
  PLATFORM_ALLOW_DEV_AUTH, WELCOME/SESSION knobs (placeholders only).

### Phase 3 contents (done, pushed)

- `packages/credits` engine: `reserve` (atomic conditional, idempotent
  retries, bounded internal retry on same-requestId collision), `commit` /
  `release` (legal-transition-only, repeat-safe, ledger `commit:<id>`),
  `getBalance`, `releaseStale` sweeper primitive. Suspended accounts cannot
  spend; amounts come from the DB registry only.
- `WalletsRepo.tryReserve` + `ReservationsRepo.listStaleReserved` +
  `RegistryRepo.getOperationById` (pg + memory + parity).
- Critic closed: 1 P1 (status guard) + 2 P2 — see CRITIC.md.
- Tests: **85/85** (71 unit + 14 live), incl. §43 live (last-credit 1/10,
  same-requestId funds-once, dup commit/release settle-once) and §45 matrix.
  Zero `itest-` leftovers verified post-run.

### Phase 4 contents (done, pushed)

- Dual-bound credit API: `POST /v1/credits/reserve|commit|release` require
  service Bearer + user session; userId only from session (no such body
  field). `GET /v1/me/balance`, `GET /v1/me/usage` (slug-resolved trail).
  Error map 402/404/403/409 + `RESERVATION_CONFLICT` code.
- `packages/platform-client`: typed auth/me/credits, cookie-jar friendly,
  `setSessionToken` server pattern, service-token-via-callback only
  (no env/storage in package). Wire-tested against ephemeral server.
- Critic closed: 8 attack cases repelled (A-1..A-8, all tested) — see
  CRITIC.md. Remaining: per-service keys, rate limits (Phase 6).
- Tests: **98/98** (84 fast + 14 live); wire proof included. Zero `itest-`
  leftovers (no DB writes in new tests).

### Phase 5 contents (done, pushed)

- `apps/account` (Vite 8 + React 19, `vite preview :4174`): session-first boot
  (cookie → dashboard; else exchange via host initData or dev persona picker),
  balance card with Russian plurals, 3 service cards (fridge open, others
  soon), day-grouped usage trail (status text, no invented amounts), logout,
  error/retry states. `hosts.ts` is the only module touching Mini App
  bridges; `platform-client` for all API calls.
- Tests: 10 unit (hosts incl. partial/malformed globals; helpers incl. TZ-safe
  day labels) + **14/14 E2E** (mocked API: login flow, 4 balance variants,
  empty usage, failure banner, 360/390/430 overflow-free, dark theme).
  Root `npm run test:e2e` added (builds account, runs Playwright on system
  Chrome — no browser download).
- Critic closed: §46 mobile pass, 4 accepted limitations documented; F-002
  (LIFO route mocks) recorded.

### Phase 6 contents (done, deployed + verified)

- Vercel project `user-platform` (scope `maximocappuccino-gmailcoms-projects`,
  `iad1`), `vercel.json` + `api/index.ts` dual-mount adapter + pooler pg Pool.
- Production: **https://user-platform-phi.vercel.app** (alias, public).
  Preview: SSO-gated (302), build-clean.
- Fixes found by deploying: dual `exports` conditions (Vercel per-file
  transpile can't load TS from `node_modules`); `in`-narrowing (Vercel
  build-time tsc runs without strictNullChecks); boundary stack logging
  (safe); F-003 (PowerShell curl quoting → `-d @file` rule).
- Live 9-point prod matrix, all green: `/` 200 own index.html; `/health` 200
  minimal; dev exchange 404; telegram garbage 400 MISSING_HASH; max without
  token 400 fail-closed; me/balance/usage 401; reserve no/forged service
  401 with exact messages; no Set-Cookie on failures; no secrets anywhere;
  logs show only request lines (+1 body-parser SyntaxError from a mangled
  probe, no payload).
- Secrets in Vercel (Preview+Production): DATABASE_URL, PLATFORM_SERVICE_TOKEN,
  TELEGRAM_BOT_TOKEN. MAX_BOT_TOKEN intentionally absent (moderation pending).
- Tests: **116/116** unit+live + **14/14** e2e (final full runs post-change).
- Remaining triggers (not blockers): O-1 MAX live-signature verify after
  moderation; first real Telegram exchange at Mini App launch; rate limiting
  needs Redis; per-service keys upgrade path documented.

### Supabase live status (verified, no secrets exchanged)

- Project `user-platform` (`ympsgyzdfgfwzwxlcnhb`), region East US (N. Virginia),
  linked locally (● in `projects list`).
- `migration list`: local == remote, both migrations applied (first real SQL
  validation — green).
- Seed verified via read-only `db query`: 3 apps, 6 operations with exact
  costs (fridge.scan=1, fridge.recipe=0, wardrobe.*=1, interior.analyze=2).
- Pre-existing projects (My Game, Mars2025, repair-bot-db, GolemMechGame,
  Motivation blues, Mars2050) untouched.

**Date:** 2026-09-19
**Repository:** `Llayon/UserPlatform` (public, created 2026-09-19 via `gh repo create`; local `D:\Programms\Max\UserPlatform` tracking `origin/master`)
**Branch:** master (`c720552` committed, clean; no remote yet)

### Verified research (2026-09-19)

- Telegram Mini Apps: official validation = HMAC-SHA256(key `WebAppData`, bot token) → HMAC-SHA256(secret, sorted `key=<value>` `\n` lines) hex vs `hash`; `initDataUnsafe` untrusted; freshness via `auth_date` (tma.js default 1 day). Sources: core.telegram.org/bots/webapps (Bot API 10.1), docs.telegram-mini-apps.com.
- MAX Mini Apps: official `window.WebApp.initData` (raw) + `initDataUnsafe` (untrusted); InitData fields include `ip?`, `auth_date` (1h recommended), `hash`, `user`, `chat{DIALOG|CHAT|CHANNEL}`, `start_param` (512 chars via `?startapp=`); HMAC-SHA256 verification required. Sources: dev.max.ru/docs/webapps/bridge, ecosystem attestations for byte layout (re-verify live in Phase 2).
- Supabase: CLI available, but no Docker locally → no local stack. Migrations authored as SQL; integration tests gate on `DATABASE_URL`.

### Scaffold contents

- `packages/contracts` — Zod schemas/types (user, session, exchange, apps, operations, balance, reserve/commit/release, usage, error codes)
- `packages/auth-core` — Telegram/MAX validators, start_param parser, session token helpers (pure, unit-tested with self-generated vectors)
- `apps/api` — Express skeleton (`GET /health` only)
- `supabase/migrations` — `0001_platform_core.sql` + `0002_seed_registry.sql` (UNAPPLIED)
- Tooling: workspaces, strict TS project references, Vitest, ESLint 9, Prettier

### Critic + Fixer (2026-09-19, closed)

- 1 BLOCKER (typecheck excluded tests) + 3 P1 (requestId charset, RLS,
  start_param boundary) + 2 P2 (usage index, JSON 404) — all fixed, see
  `.gauntlet/CRITIC.md`. Tests 30 → 32. No open BLOCKER/P1.

### Open questions for Phase 1/2 (not Phase 0 blockers)

- MAX byte-layout live re-verification (hard gate before MAX exchange in prod).
- Session revocation design (freshness 3600s depends on it).
- `DATABASE_URL`-gated integration tests (need Supabase project).

### Supabase CLI status (2026-09-19, verified via CLI 2.117.0)

- `supabase init` done: `supabase/config.toml` (`project_id = "UserPlatform"`) committed.
- Migrations renamed to CLI timestamp convention (`20260919143000_*`,
  `20260919143100_*`); still UNAPPLIED.
- CLI is NOT authenticated (`projects list` → "Access token not provided").
  No project created, no credentials invented — see SUPABASE SETUP CHECKPOINT.
- Local `supabase start` / `db lint` impossible here (no Docker); SQL
  validated by critic review only. First real validation = `db push` output.

## SUPABASE SETUP CHECKPOINT READY

STOP — a Supabase project does not exist yet and the CLI has no access token.
Everything applicable without auth is done (code, migrations, `config.toml`).
Do NOT invent credentials. Run the steps below in YOUR terminal (secrets stay
local, never paste them in chat). CLI verified: 2.117.0.

**Why Supabase:** managed PostgreSQL (source of truth for accounts/credits),
migration-tracked schema, no server to maintain. Region `us-east-1`
(N. Virginia) — closest to Vercel `iad1` where Holodilnik runs.

**Step 1 — authenticate (interactive, browser OAuth, token stays local):**

```
cd D:\Programms\Max\UserPlatform
supabase login
```

**Step 2 — pick the organization (must be YOUR org, not a random one):**

```
supabase orgs list
```

**Step 3 — create the project (free tier is enough for Phase 1):**

```
# Generate the DB password locally first (never in chat):
# PowerShell: -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
supabase projects create user-platform --org-id <org-id-from-step-2> --db-password <generated> --region us-east-1
```

Wait until status is ACTIVE_HEALTHY (`supabase projects list`).

**Step 4 — link the repo and push migrations:**

```
supabase link --project-ref <project-ref>
supabase db push
```

Expected: both migrations applied (`platform_core`, `seed_registry`).
This is the first REAL validation of the SQL — report any error verbatim.

**Step 5 — wire secrets (server-only; public-safe vs secret split):**

```
supabase projects api-keys --project-ref <project-ref> --reveal
```

Set locally in `.env.local` (gitignored) and later in Vercel env:

```
# Server-only secrets:
DATABASE_URL=postgresql://postgres:<db-password>@db.<ref>.supabase.co:5432/postgres
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role key from api-keys>
# Public-safe (Phase 5 account UI only):
VITE_PLATFORM_API_URL=http://localhost:3002
```

Do NOT set `SUPABASE_ANON_KEY` anywhere — the API uses service-role
server-side only (RLS is deny-by-default, see migration 0001).

**Step 6 — tell me "Supabase ready + project ref".** I will then verify
(`supabase migration list`, seed row counts) and start Phase 1
(repositories + `DATABASE_URL`-gated integration tests).

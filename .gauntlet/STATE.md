# STATE.md — UserPlatform Checkpoint

## Current Checkpoint: PHASE 1 — DATABASE CORE (VERIFY green, ready to commit)

**Date:** 2026-09-19
**Repository:** `Llayon/UserPlatform` (public, `origin/master` tracking)
**Branch:** master

### Phase 1 contents (this pass)

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

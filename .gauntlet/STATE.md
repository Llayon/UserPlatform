# STATE.md — UserPlatform Checkpoint

## Current Checkpoint: PHASE 0 — RESEARCH + ARCHITECTURE (VERIFY green, ready to commit)

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

### Manual steps required

- ~~Create GitHub repo `Llayon/UserPlatform`~~ — DONE 2026-09-19 via gh CLI (public, `origin/master` tracking, 2 commits pushed).
- Create Supabase project → SUPABASE SETUP CHECKPOINT (Phase 1 needs it).

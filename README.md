# UserPlatform — shared account/identity/credits layer for AI Mini Apps

One internal account, one shared credit balance, one usage history across
Telegram / MAX / Web and across Holodilnik, Wardrobe, Interior, future apps.

## Status

Phase 0 (research + architecture). See `.gauntlet/STATE.md`.

## Layout

- `packages/contracts` — shared Zod schemas/types (single source of truth)
- `packages/auth-core` — Telegram/MAX initData validators, start_param, sessions (pure, DB-free)
- `apps/api` — Express Platform API (skeleton in Phase 0)
- `apps/account` — mobile account UI (Phase 5)
- `supabase/migrations` — PostgreSQL schema (UNAPPLIED until Supabase project exists)

## Rules

- Supabase/PostgreSQL is the source of truth for accounts and credits. Redis is rate-limit/cache only.
- Never expose service credentials to the browser (no `VITE_*` secrets).
- No live Telegram/MAX/Supabase calls in standard tests.
- Gauntlet mode: BUILDER → CRITIC → FIXER → VERIFY per phase.

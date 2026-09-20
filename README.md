# UserPlatform — shared account/identity/credits layer for AI Mini Apps

One internal account, one shared credit balance, one usage history across
Telegram / MAX / Web and across Holodilnik, Wardrobe, Interior, future apps.

## Status

UserPlatform Core + Service Bridge are implemented, migrated, and deployed.
See `.gauntlet/STATE.md` for the current checkpoint.

- Production: **https://user-platform-phi.vercel.app**
- Supabase project `user-platform` (`us-east-1`); all migrations applied,
  including `20260920000000_service_bridge` (per-app credentials + app-scoped
  sessions).
- Holodilnik is NOT integrated yet (this repo ends at `SERVICE BRIDGE READY`;
  the next gauntlet wires the fridge backend).

## Layout

- `packages/contracts` — shared Zod schemas/types (single source of truth,
  incl. server-only `ServicePlatformExchangeResult`)
- `packages/auth-core` — Telegram/MAX initData validators, start_param,
  sessions, per-app service credentials (pure, DB-free)
- `packages/db` — row types, repository interfaces, `pg` adapter, memory fakes
- `packages/credits` — reserve → commit | release engine (ledger-first)
- `packages/platform-client` — browser `PlatformClient` + server-only
  `ServerPlatformClient` (`/server` entry; service exchange + credits)
- `apps/api` — Express Platform API (`/v1/auth`, `/v1/me`, `/v1/credits`,
  `/v1/service`) + operator CLI (`service:create|list|revoke|rotate`)
- `apps/account` — mobile account UI
- `supabase/migrations` — PostgreSQL schema (all applied)
- `docs/service-bridge.md` — service auth, app sessions, credit authority,
  server bridge, rotation, threat model

## Rules

- Supabase/PostgreSQL is the source of truth for accounts and credits. Redis is rate-limit/cache only.
- Internal UUID is canonical; Telegram/MAX numeric IDs are namespaced identities.
- Service authority is per-app DB credentials (`ups_<keyId>_<secret>`,
  hash-only storage). No global service token. Identity comes from
  credential→app mapping only.
- Credit invariant: `SERVICE APP == SESSION APP == OPERATION APP`
  (registry `operation.app_id` authoritative). Account sessions are read-only.
- Never expose service credentials to the browser (no `VITE_*` secrets).
- Never log initData, tokens, secrets, or raw identifiers beyond hashed keys.
- No live Telegram/MAX/Supabase calls in standard tests (gated live tests
  use `DATABASE_URL` and clean up `itest-` rows).
- Gauntlet mode: BUILDER → CRITIC → FIXER → VERIFY per phase.

# DECISIONS.md — UserPlatform Architecture Records

## ADR-001: Internal UUID as canonical identity

- **Decision:** `users.id` UUID is the only in-app identity. Provider numeric IDs live in `user_identities` under `UNIQUE(provider, provider_user_id)`.
- **Context:** Telegram 123 ≠ MAX 123; usernames/names are unstable and spoofable. Verified both platforms expose numeric user IDs inside signed initData.
- **Consequence:** Cross-platform linking must be explicit future work, never auto-matched.

## ADR-002: Bot-token HMAC validation for both Telegram and MAX

- **Decision:** Shared `initdata.ts` primitive (HMAC-SHA256 `WebAppData` scheme, constant-time compare); separate `telegram.ts` / `max.ts` validators with provider-specific strictness (MAX: 1h freshness default, duplicate-key rejection, chat-type enum).
- **Context:** Telegram official docs specify the scheme; MAX official docs require HMAC verification with the bot token and recommend 1h freshness, byte layout attested by ecosystem (re-verify live in Phase 2).
- **Consequence:** One code path for crypto, explicit per-provider policy. MAX byte layout flagged for live re-verification before prod.

## ADR-003: Freshness default 3600s for exchange

- **Decision:** `auth_date` max age 3600s (both), future tolerance 60s Telegram / 30s MAX.
- **Context:** Exchange mints a 30-day session, so launch data must be fresh. MAX officially recommends 1h.
- **Consequence:** Stolen initData replay window ≤1h (+ session theft still possible post-exchange → sessions must be revocable, Phase 2).

## ADR-004: Ledger-first credits with explicit reservations table

- **Decision:** `credit_ledger` (UNIQUE(user_id, idempotency_key)) is audit truth; `credit_wallets` (CHECK ≥ 0, version) is cached balance; `reservations` (UNIQUE(user_id, request_id), status machine) models reserve→commit/release.
- **Context:** Must survive concurrent reserves, retries, crashes without double-spend or negative balances on serverless.
- **Consequence:** All mutations transactional with row locks + constraints; Redis never authoritative.

## ADR-005: Repository isolation over scattered Supabase calls

- **Decision:** All Postgres access behind repository interfaces; Supabase client confined to adapters. Integration tests gate on `DATABASE_URL`, else skip.
- **Context:** No Docker locally; future migration to plain Postgres/VPS must be possible.
- **Consequence:** Unit tests use in-memory fakes; real concurrency proofs require Supabase project (checkpoint).

## ADR-006: Monorepo workspaces with contracts package

- **Decision:** `packages/contracts` (Zod) is the single source of API shapes; apps import it, never duplicate schemas.
- **Context:** Future apps (Wardrobe etc.) must consume typed platform contracts.
- **Consequence:** TS project references; contracts has zero infra deps.

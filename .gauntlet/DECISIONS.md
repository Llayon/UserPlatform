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

## ADR-007: Database package with executor seam (Phase 1)

- **Decision:** `packages/db` holds domain row types, repository interfaces,
  a `pg` adapter (`postgres.ts` — the only file importing the driver),
  in-memory fakes with identical constraint semantics, and
  `DATABASE_URL`-gated integration tests. Repositories take the executor
  per-call, so the same bundle works inside `withTransaction`.
- **Context:** Supabase is Postgres; `pg` Pool works against it via
  `DATABASE_URL`. Supabase-specific code is one factory function.
- **Consequence:** Unit tests run without a DB; integration tests skip
  without `DATABASE_URL`; real race proofs need the live project.

## ADR-008: Exchange sessions via HttpOnly cookies, reads-only (Phase 2)

- **Decision:** `POST /v1/auth/platform/exchange` validates signature, runs a
  single signup-or-login transaction (user+identity+profile+wallet+welcome
  ledger+acquisition+session), sets `up_session` cookie (prod: HttpOnly+
  Secure+SameSite=None; dev: HttpOnly+Lax) and returns user/isNewUser/balance.
  `GET /v1/me` binds identity from the session hash only. Loser of a
  parallel-signup race retries once as login (no bonus path). Dev personas
  behind `PLATFORM_ALLOW_DEV_AUTH` + non-prod, 404 otherwise.
- **Context:** Mini App webviews fetch cross-site (None+Secure required);
  localhost dev is same-site (Lax suffices). Cookie guards reads; credit
  mutations will be service-authed, so no CSRF layer for this surface.
- **Consequence:** Race-safe welcome (constraint-enforced), revocable
  sessions, explicit cookie contract covered by tests in both modes.

## ADR-009: Credit engine with database-decided races (Phase 3)

- **Decision:** `packages/credits` implements reserve→commit|release with one
  transaction per call: conditional single-statement `tryReserve` (null =
  insufficient, row lock serializes last-credit races), idempotent reserve
  reads (same requestId returns the winner, bounded internal retry),
  legal-transition-only commit/release (repeats are no-ops), ledger rows only
  for net movements (`welcome_bonus`, `commit:<id>`), append-only usage trail,
  crash recovery via `releaseStale` sweeper primitive. Suspended accounts
  cannot spend (`ACCOUNT_SUSPENDED`); amounts always come from the DB
  operation row, never the client.
- **Context:** Serverless concurrency makes application-level balance checks
  unsound; every race must be decided by constraints or atomic statements.
- **Consequence:** §43 proven live (1/10 wins, never negative) and §45 matrix
  green on fakes; HTTP/service-auth wiring is Phase 4.

## ADR-010: Dual-bound service API + reusable client (Phase 4)

- **Decision:** Credit mutations require BOTH a service Bearer token
  (constant-time vs primary/previous, fail-closed when unconfigured) AND the
  user's session (cookie or X-Platform-Session). The acting userId comes only
  from the session — request bodies have no userId field (IDOR-proof by
  shape). `packages/platform-client` offers typed
  auth/me/credits calls; service tokens enter only via injected callback, and
  the package contains no env/storage access (grep-verified), so browser
  builds cannot leak them. Rotation = PREVIOUS grace token.
- **Context:** Service backends must spend for exactly the user behind the
  request, without ever naming UUIDs from client JSON.
- **Consequence:** 8 attack cases tested green; `/me/balance`, `/me/usage`
  and credit endpoints share one binding helper; account UI (Phase 5) and
  future apps consume the client.

## ADR-011: Account UI with single host-abstraction point (Phase 5)

- **Decision:** `apps/account` (Vite + React, one screen, plain CSS) consumes
  `platform-client`; exactly one module (`hosts.ts`) touches
  `window.Telegram`/`window.WebApp`, everything else uses the normalized
  adapter (Telegram → MAX → browser fallback, never throwing). E2E mocks the
  API with stateful handlers (401 until exchange) and asserts viewports,
  themes, balances, overflow and error states.
- **Context:** Mini Apps run inside Telegram/MAX webviews with different
  bridges; scattered globals would rot. UI must be thumb-first at 360–430px.
- **Consequence:** Host-specific code is quarantined and unit-tested;
  dashboard proven at 3 viewports + dark theme + edge data.

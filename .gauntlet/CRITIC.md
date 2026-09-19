# CRITIC.md — latest critic findings and resolution status

## Phase 0 critic pass — 2026-09-19 (CLOSED, all BLOCKER/P1 fixed)

Critic attacked the scaffold for correctness, security, gates honesty and
portability before any commit. Findings below; FIXER resolutions verified by
`typecheck` + `test` (32/32).

### C-001 [P1] `requestId` accepted arbitrary strings — FIXED

- **Attack:** `reserveRequestSchema.requestId` was `z.string().min(8).max(128)` —
  newlines, spaces, control chars pass validation, then flow into a DB unique
  key, logs and headers.
- **Fix:** charset-restricted to `/^[A-Za-z0-9_:\-.]{8,128}$/` with a comment
  stating why. Regression tests: newline and space payloads rejected.
- **Status:** resolved.

### C-002 [BLOCKER] `tsc -b` did not typecheck tests — FIXED

- **Attack:** package tsconfigs had `rootDir: ./src` + `include: ["src"]`, so a
  broken test file still passes `npm run typecheck`. Gates would lie.
- **Fix:** removed `rootDir`, `include: ["src", "test"]` in all three
  tsconfigs. Verified `typecheck` builds refs including tests.
- **Status:** resolved.

### C-003 [P1] Migrations enable no RLS — FIXED

- **Attack:** if Supabase Data API anon credentials ever exist, all platform
  tables (wallets, ledger, sessions) would be readable/writable by default.
  Architecture says "service-role server-side only", but the DB did not
  enforce it.
- **Fix:** `ALTER TABLE … ENABLE ROW LEVEL SECURITY` for all 11 tables with
  zero public policies (deny-by-default) + comment. Access only via
  service-role from `apps/api`.
- **Status:** resolved.

### C-004 [P2] `usage_events.request_id` unindexed — FIXED

- **Attack:** idempotency/lookup by `request_id` would seq-scan a hot table.
- **Fix:** added `usage_events_request_id_idx`.
- **Status:** resolved.

### C-005 [P2] No JSON 404 handler — FIXED

- **Attack:** unknown routes fall through to Express default HTML (info
  shape leak, content-type confusion for Mini App clients).
- **Fix:** JSON `{ error, code: "NOT_FOUND" }` catch-all + regression test.
- **Status:** resolved.

### C-006 [P1] Validator returns raw `start_param` — FIXED (boundary documented)

- **Attack:** `validateTelegramInitData` / `validateMaxInitData` return the
  signed `start_param` verbatim (up to 256 chars). A signed-but-hostile value
  like `../../etc/passwd` would pass auth and could be stored/routed on.
- **Fix:** explicit `NOTE` at both return sites: authenticity ≠ safety;
  exchange boundary MUST run `parseStartParam()` before storage/analytics,
  never route on the value. Added regression test proving a signed evil
  value validates (`ok: true`) yet sanitizes to `invalid`. Transport bound
  (512) vs sanitizer bound (64) documented in contracts.
- **Status:** resolved.

### Open items (NOT blockers for Phase 0, gated to later phases)

- **O-1 MAX byte layout:** official MAX docs require HMAC but the byte-exact
  check-string is ecosystem-attested. Live re-verification with a real MAX
  bot token is a hard gate before Phase 2 exchange trusts MAX in prod.
- **O-2 Freshness 3600s:** acceptable for exchange-issues-30d-session only
  with revocable server sessions (Phase 2 must implement revocation).
- **O-3 Session rotation:** helpers are pure; storage/rotation/cookie
  binding lands in Phase 2.
- **O-4 Concurrency proof:** in-memory fakes prove nothing about Postgres;
  real race tests require `DATABASE_URL` (SUPABASE SETUP CHECKPOINT).

No open BLOCKER or P1. Phase 0 may commit.

## Phase 1 critic pass — 2026-09-19 (CLOSED, all fixed)

Critic attacked `packages/db` (interfaces, pg adapter, memory fakes, gated
integration tests) for constraints, indexes, race safety and portability.

### C-101 [BLOCKER] Root tsconfig skipped the new package — FIXED

- **Attack:** `tsconfig.json` references lacked `./packages/db`, so
  `npm run typecheck` passed without compiling a single db file (C-002
  recurrence). Same lie, new package.
- **Fix:** added the reference + `include: ["test/setup.ts"]`. Cascade fix:
  `apps/api` needed `composite: true` once the root program included files.
- **Status:** resolved. Lesson: any new workspace package must update the
  root reference graph — future critic passes check this first.

### C-102 [P2] Memory fake accepted invalid user status — FIXED

- **Attack:** `users.create` in memory accepted any status string; Postgres
  CHECK would reject. Fake weaker than schema → unit tests lie.
- **Fix:** fake validates `active|suspended`, throws DbCheckError otherwise.
- **Status:** resolved.

### C-103 [P2] Test pool never closed — FIXED

- **Attack:** lazy pg Pool in `postgres.test.ts` stayed open after the run
  (hang risk under different runners).
- **Fix:** `afterAll` closes the pool.
- **Status:** resolved.

### C-104 [P2] Nested-transaction deadlock footgun — FIXED (documented)

- **Attack:** `withTransaction` on a small pool + a nested call = self-deadlock.
- **Fix:** documented non-nesting contract on the `Db` interface. Phase 2/3
  services compose on the passed `tx`, never re-enter.
- **Status:** resolved.

### Reviewed and accepted (no change)

- RLS deny-by-default is defense-in-depth only; tests connect as owner
  (bypass). Primary cross-user isolation must be proven at the API layer in
  Phase 4 critic (IDOR attack) — recorded as a Phase 4 gate.
- `createRepos()` returns stateless singletons; executors pass per-call, so
  concurrent serverless use is safe.
- Integration tests create/delete random `itest-` users with cascade cleanup;
  seeds are read-only. Safe against the shared live project.
- `adjust`/`transition` SQL reviewed: `$4::int` null-guard, `status = ANY($3)`
  array binding, optimistic-version null-row contract. Real race proof waits
  for `DATABASE_URL` (9 tests currently skip by design).

No open BLOCKER or P1. Phase 1 may commit.

## Phase 2 critic pass — 2026-09-19 (CLOSED, all fixed)

Critic ran the §36 checklist against the exchange service, routes, cookies
and session handling, actively trying to break auth, bonus and isolation.

### C-201 [P1] Exchange response fabricated `createdAt` — FIXED

- **Attack:** `toPublicResult` filled `user.createdAt` with `new Date()`,
  so every exchange (including returning users) reported "just created".
- **Fix:** `ExchangeOutcome` carries the real `userCreatedAt` from the DB row
  in both paths; contract validation pins the shape.
- **Status:** resolved.

### C-202 [P1] IDOR binding unproven — FIXED (test)

- **Attack:** `/v1/me` takes no user parameter at all (binding is
  cookie→hash→user server-side), but no test demonstrated two agents seeing
  only themselves.
- **Fix:** added agent-A/agent-B isolation test (distinct users, each `/me`
  returns its own UUID).
- **Status:** resolved.

### Reviewed and accepted (no change)

- Signatures: tamper/wrong-token/dupe-hash/expired/future/missing-user all
  rejected with distinct codes (unit + HTTP tested). Replay window = 1h max,
  documented; sessions revocable via DELETE /session (tested).
- Fixation: server always mints fresh tokens; clients never supply one.
  Theft surface: HttpOnly always; Secure+None in prod (tested), Lax in dev.
- Bonus race: 10-way parallel exchange proven live (1 user, 1 ledger row)
  plus memory-level equivalent. `welcome_bonus` idempotency is a DB
  constraint, not an app check.
- start_param: signed-evil → sanitized `""`; explicit wins; first-seen never
  overwritten (all tested).
- No secrets in code paths: service/route files contain zero logging of
  initData, tokens or hashes (verified by inspection).
- Cookie guards READS only; credit mutations stay service-authed (Phase 4).
  Future user-mutating endpoints must add CSRF — recorded as a Phase 4 gate
  alongside the API-level IDOR attack.
- Exchange rate limiting absent (no Redis in this repo yet) — recorded as a
  Phase 4/6 gap, not a Phase 2 blocker (abuse impact bounded: attacker can
  only create sessions, never spend).

No open BLOCKER or P1. Phase 2 may commit.

## Phase 3 critic pass — 2026-09-19 (CLOSED, all fixed)

Critic attacked the credit engine for double-spend, last-credit races,
idempotency holes and privilege gaps.

### C-301 [P1] Engine ignored user status — FIXED

- **Attack:** `reserve`/`commit`/`release` never loaded the user row, so a
  suspended account could keep spending through service calls.
- **Fix:** `requireActiveSpender` inside every spend transaction: suspended
  → `ACCOUNT_SUSPENDED`; unknown → fail-closed `INSUFFICIENT_CREDITS`;
  oversized operation/requestId rejected before UNIQUE keys or logs. Reads
  (`getBalance`) stay open. Regression test included.
- **Status:** resolved.

### C-302 [P2] `releaseStale` bypassed the repository layer — FIXED

- **Attack:** the sweeper ran raw SQL through the executor, so memory fakes
  (noop executor) returned zero rows and the stale path was untestable
  without Postgres — portability seam violated.
- **Fix:** new `ReservationsRepo.listStaleReserved` (pg + memory impls);
  engine uses it. Unit test covers the sweep.
- **Status:** resolved.

### C-303 [P2] Same-millisecond flake in stale test — FIXED

- **Attack:** `createdAt == cutoff` fails strict `<`, flaking when reserve
  and sweep land in one ms.
- **Fix:** test passes an explicit future `nowMs` (deterministic clock).
- **Status:** resolved.

### Reviewed and accepted (no change)

- Last-credit race decided by single-statement conditional UPDATE (row lock
  serializes); proven live 9×INSUFFICIENT + 0/1 final.
- Same-requestId collision aborts its own deduction (rollback) and retries
  once as a read; funds move exactly once (proven live ×10).
- Commit race settles once via conditional transition; ledger
  `commit:<id>` key is second-layer defense (nearly unreachable in practice,
  kept deliberately).
- Release writes no ledger row: net movement is zero, trail lives in
  usage_events (documented in engine header).
- Amount always comes from the DB operation row — clients can only name an
  operation and a requestId (contract has no cost field, tested).
- Sweeper is per-item and race-tolerant (loser sees settled state, no error,
  no double move).

## Phase 4 critic pass — 2026-09-19 (CLOSED, no BLOCKER/P1)

Critic attacked service impersonation and IDOR on the new routes and client.

### Attacks executed (all repelled, all tested)

- **A-1 no service token** (valid session, credit call): 401. Service
  credential is mandatory, never optional.
- **A-2 no user session** (valid service token): 401. A service alone names
  no user — there is no userId field to fall back to.
- **A-3 forged service token**: 401. Comparison is SHA-256 +
  timingSafeEqual (length not leaked).
- **A-4 unconfigured service** (empty PLATFORM_SERVICE_TOKEN): 401
  fail-closed. Credit endpoints are unusable rather than open.
- **A-5 cross-user spend**: service + sessionB committing sessionA's
  reservation → 404. Binding is session→user server-side; reservation
  ownership re-checked by the engine.
- **A-6 userId smuggling**: `{..., userId: "anything"}` in the body is inert
  (contract has no such field; zod strips it). Proven by test asserting the
  spend lands on the session owner's balance.
- **A-7 rotation**: previous token honored, ancient token rejected.
- **A-8 client bundle leak**: `platform-client/src` contains zero
  `process.env`/`localStorage` references (grep-verified); service calls
  throw client-side without an injected callback, so a browser build cannot
  accidentally carry the token.

### Reviewed and accepted (no change)

- User cookie guards reads; credit mutations need service + session (dual).
  Suspended users fail at the engine (Phase 3 guard inherited).
- Error mapping pins wire codes (402/404/403/409 + closed code set).
- Usage `appSlug` resolved server-side from the registry (no client join).
- Remaining gaps (not Phase 4 blockers): per-service keys (single shared
  token + rotation today; upgrade path documented in .env.example),
  exchange/credit rate limiting (needs Redis — Phase 6 concern).

No open BLOCKER or P1. Phase 4 may commit.

## Phase 5 critic pass — 2026-09-19 (mobile UX §46)

Critic reviewed the dashboard against every §46 case plus failure analysis
(F-002 was a test-harness bug, fixed, not an app bug).

### Verified by test

- 360×800 / 390×844 / 430×932: no horizontal overflow (asserted
  `scrollWidth - clientWidth ≤ 1`), logout CTA visible at each size.
- Dark theme follows host (`data-theme`, asserted); light is default.
- Balances 0 / 1 / 2 / 1250 render correct Russian plurals (asserted).
- Long display name wraps without overflow (`overflow-wrap: anywhere`,
  asserted at 360px). Missing avatar → initial letter (always rendered).
- Empty usage → friendly note (asserted). Logout CTA never clipped.
- Exchange failure → banner + retry (asserted). No desktop-sidebar
  dependency (single centered 480px column).

### Accepted limitations (documented, not fixed)

- Usage rows show status text ("готово / в обработке / …"), never amounts:
  `usage_events` carries no amount and inventing "−1" would lie for free
  operations (e.g. `fridge.recipe` = 0). Amount display needs a schema
  change — deferred, not silent.
- MAX safe-area insets are zeros (bridge docs expose no safe-area API we
  could verify); Telegram `safeAreaInset` is mapped. Zero is the safe
  fallback, never a negative.
- 50-row usage lists render unvirtualized (fine at this cap; revisit if the
  limit grows).
- Photo preview (`photo_url`) is not rendered — initial letter only. Deliberate
  minimal scope; no extra image fetching in v1.

No open BLOCKER or P1. Phase 5 may commit.

## Phase 6 critic pass — deployment security checklist (2026-09-20)

- Production mock auth: `POST /v1/auth/dev/exchange` → 404 live. Double
  guarantee: `allowDevAuth` requires explicit flag AND non-production
  (unit-tested incl. `VERCEL_ENV=preview` posture).
- Secrets: `/health` minimal (no keys); error bodies carry codes only;
  boundary log line carries stacks without tokens/initData/connection
  strings (verified in live logs — only a body-parser SyntaxError from a
  mangled probe, no payload content). No `VITE_*` secrets exist.
- Fail-closed: no `DATABASE_URL` → boot throws (tested); no bot token →
  exchange 400 (live); no service token → credit endpoints 401 (live +
  tested); insufficient/wrong credentials → 401/402/404 per contract.
- Preview SSO gate active (302 on `/` and `/api/health`); untouched.
- RLS deny-by-default already migrated; API uses service-role server-side.
- Exchange rate limiting still absent (no Redis in this repo) — carried as
  the single known hardening gap; abuse impact today: session minting only,
  no spending without service token.
- Live exchange with a real Telegram signature not performed from curl
  (impossible without a client-held bot signature) — proven by 71
  exchange/auth tests + live-DB race instead; first real exchange is a
  defined follow-up trigger alongside MAX O-1 verification.

No open BLOCKER or P1. Phase 6 may commit.

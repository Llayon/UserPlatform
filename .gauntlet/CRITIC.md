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

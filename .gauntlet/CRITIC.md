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

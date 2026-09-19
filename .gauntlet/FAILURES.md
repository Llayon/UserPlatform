# FAILURES.md — UserPlatform Known Issues

## F-001: Direct Supabase connection unreachable from dev machine (IPv6 blackhole)

- **Symptom:** All 9 `postgres.test.ts` integration tests timed out at 5000ms
  on the very first query; `afterAll` pool close also timed out. Unit suites
  stayed green (42/42), so repo code was not the cause.
- **Cause:** `DATABASE_URL` used the direct hostname
  `db.<ref>.supabase.co:5432`, which resolves to IPv6-only from this network,
  and TCP is blackholed (diagnosed via DNS+TCP probe: `tcp_5432=TIMEOUT`,
  `tcp_6543=TIMEOUT` on the direct host — no secrets printed, host/port only).
- **Fix:** use the Supavisor pooler hostname
  `aws-0-us-east-1.pooler.supabase.com:6543` (IPv4, `tcp_6543=OPEN`,
  user `postgres.<ref>`, same DB password) as `DATABASE_URL`. Explicit
  BEGIN/COMMIT transactions work through the pooler in tests.
- **Rule:** integration-test timeouts on EVERY test (not one) mean
  connectivity, not logic — probe TCP before touching code.

## F-003: PowerShell inline `-d` JSON mangled → phantom 500s on live API

- **Symptom:** Every `curl.exe -d '{"a":1}'` POST to production returned 500
  `INTERNAL_ERROR`, including routes with no handler (POST /health) — looked
  like a server bug after a correct deploy.
- **Cause:** PowerShell mangles embedded double quotes when passing inline
  `-d` strings to native curl.exe (body arrived as invalid JSON; body-parser
  `SyntaxError` at position 1). Same family as Holodilnik F-009.
- **Fix:** send bodies byte-exact via `-d @file` (UTF-8 no BOM). Re-ran the
  matrix: all green. The boundary log line added during diagnosis is kept
  permanently (safe: our errors carry codes only, never tokens/initData).
- **Rule:** never inline JSON in PowerShell curl; always `-d @file`.

## F-002: Playwright route handlers match LIFO + session persists across goto

- **Symptom:** 12/14 account E2E failed with `persona-screen` timeout, while
  the error-path test passed. App never left `booting`.
- **Cause:** two stacked issues. (1) A second `page.route("**/v1/me")`
  registration silently overrode the first (Playwright matches LIFO), so the
  boot-time 401 became a 200 and the persona screen never rendered. (2) In
  the viewport loop, the session cookie survived `goto`, so iteration 2
  skipped login legitimately — test bug, not app bug.
- **Fix:** single stateful mock per pattern (401 until exchange flips an
  `authed` flag); per-iteration `clearCookies` + `unrouteAll` + fresh mocks.
- **Rule:** one stateful handler per URL pattern in E2E; never stack
  overlapping route mocks.

## Watch

- MAX byte-level check-string layout not quoted verbatim in official docs fetched; re-verify with live MAX bot token in Phase 2 before trusting MAX exchange in prod.
- No Docker → no local Supabase stack; do not pretend in-memory fakes prove Postgres concurrency.
- `vercel env pull` redacts Sensitive values (learned on Holodilnik) — plan Supabase secret handling accordingly.
- Supabase CLI without auth cannot validate migrations (`db lint` needs Docker,
  `migration list`/`db push` need a linked project). `supabase init` output
  (`config.toml`) committed; first real SQL validation happens at `db push`.
- Migration filenames use CLI timestamp convention (`20260919143*.sql`);
  original `0001_/0002_` names were renamed before first apply (no history).

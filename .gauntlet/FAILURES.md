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

## Watch

- MAX byte-level check-string layout not quoted verbatim in official docs fetched; re-verify with live MAX bot token in Phase 2 before trusting MAX exchange in prod.
- No Docker → no local Supabase stack; do not pretend in-memory fakes prove Postgres concurrency.
- `vercel env pull` redacts Sensitive values (learned on Holodilnik) — plan Supabase secret handling accordingly.
- Supabase CLI without auth cannot validate migrations (`db lint` needs Docker,
  `migration list`/`db push` need a linked project). `supabase init` output
  (`config.toml`) committed; first real SQL validation happens at `db push`.
- Migration filenames use CLI timestamp convention (`20260919143*.sql`);
  original `0001_/0002_` names were renamed before first apply (no history).

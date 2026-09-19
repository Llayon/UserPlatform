# FAILURES.md — UserPlatform Known Issues

(None yet — Phase 0.)

## Watch

- MAX byte-level check-string layout not quoted verbatim in official docs fetched; re-verify with live MAX bot token in Phase 2 before trusting MAX exchange in prod.
- No Docker → no local Supabase stack; do not pretend in-memory fakes prove Postgres concurrency.
- `vercel env pull` redacts Sensitive values (learned on Holodilnik) — plan Supabase secret handling accordingly.
- Supabase CLI without auth cannot validate migrations (`db lint` needs Docker,
  `migration list`/`db push` need a linked project). `supabase init` output
  (`config.toml`) committed; first real SQL validation happens at `db push`.
- Migration filenames use CLI timestamp convention (`20260919143*.sql`);
  original `0001_/0002_` names were renamed before first apply (no history).

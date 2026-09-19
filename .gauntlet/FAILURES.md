# FAILURES.md — UserPlatform Known Issues

(None yet — Phase 0.)

## Watch

- MAX byte-level check-string layout not quoted verbatim in official docs fetched; re-verify with live MAX bot token in Phase 2 before trusting MAX exchange in prod.
- No Docker → no local Supabase stack; do not pretend in-memory fakes prove Postgres concurrency.
- `vercel env pull` redacts Sensitive values (learned on Holodilnik) — plan Supabase secret handling accordingly.

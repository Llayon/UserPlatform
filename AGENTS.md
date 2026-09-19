# AGENTS.md — UserPlatform

## Project: UserPlatform (shared account/identity/credits for AI Mini Apps)

### Stack

- Node 24+, TypeScript strict, Express 5, React 19, Vite
- Supabase/PostgreSQL (source of truth), Zod 4, Vitest, Playwright

### Architecture

```
Telegram / MAX / Web → Platform identity (internal UUID) → Apps (fridge, wardrobe, interior)
```

- Internal UUID is canonical. Telegram/MAX numeric IDs are namespaced identities, never primary keys.
- Credits are global (one wallet per user). Ledger is audit truth; wallet is cached balance.
- Redis: rate limits/cache only. Never authoritative for credits.

### Conventions (borrowed from Holodilnik reference)

- `.env.example` placeholders only; `.env*local` gitignored; no `VITE_*` secrets.
- Fail-closed in production (no mock auth, no memory fallback for durable state).
- Mock/live separation: mock identities for dev/tests, never enabled in production.
- Never log initData, tokens, secrets, raw identifiers beyond hashed keys.

### Gauntlet

- `.gauntlet/STATE.md` current truth, `DECISIONS.md` ADRs, `FAILURES.md` regressions, `CRITIC.md` latest findings.
- Per phase: BUILDER → CRITIC → FIXER → VERIFY. No phase commits with red gates or open BLOCKER/P1.
- Do NOT modify Holodilnik. Read-only reference.

### Scripts

- `npm run format:check` / `lint` / `typecheck` / `test` / `build` (+ `test:e2e` where applicable)
- Integration tests requiring Postgres run only with `DATABASE_URL` set, else skip.

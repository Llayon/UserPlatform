# Service Bridge — multi-app authority

Target flow:

```
Telegram/MAX → app backend → (service credential) → UserPlatform
  → internal UUID → app-scoped session → app backend → credits → shared wallet
```

## SERVICE AUTH — credential → app principal

- Table `service_credentials`: `app_id FK apps(id) ON DELETE RESTRICT`
  (deleting an app with credentials fails instead of orphaning authority),
  `key_id UNIQUE`, `secret_hash` only, `status active|revoked`, `expires_at`,
  `revoked_at`, `last_used_at` (audit metadata, non-secret).
- Token `ups_<keyId>_<secret>`: hex segments (keyId 12 bytes, secret 32 bytes
  = 256-bit entropy). Shown ONCE by `service:create`; DB keeps SHA-256 only;
  verify with `timingSafeEqual`. Malformed tokens rejected before any DB lookup.
- `resolveServicePrincipal`: parse → lookup by `key_id` → constant-time verify
  → active → unexpired → app exists → app not `disabled` (403) → touch
  `last_used_at` best-effort. Unknown-key and wrong-secret are
  indistinguishable (both 401). Callers never declare `app` via header/body.
- CLI: `service:create -- --app <slug> --label <l>`, `service:list -- --app`,
  `service:revoke -- --key-id`, `service:rotate -- --app --old-key-id`.
  LIST never prints secrets/hashes.

## APP SESSION — platform identity → app-scoped session

- `sessions`: `session_type account|app` + `app_id FK apps ON DELETE CASCADE`
  with `CHECK ((account AND app_id IS NULL) OR (app AND app_id NOT NULL))`
  (enforced in Postgres AND memory fakes).
- `account`: minted by browser `POST /v1/auth/platform/exchange` (HttpOnly
  cookie, JSON never contains a raw token). Keeps `/me`, balance, usage,
  logout. Cannot mutate credits (403 even with a service credential).
- `app`: minted ONLY by `POST /v1/service/auth/platform-exchange`
  (service-authenticated, no Set-Cookie). Raw opaque token goes to the trusted
  backend only; DB keeps the hash. Bound to `service.appId`.
- Migration defaults old rows to `account`, so production sessions survive.

## CREDIT AUTHORITY — service == session == operation

On every `reserve|commit|release`:

1. `session.sessionType == app` and `session.appId == service.appId`, else 403.
2. `reserve`: `operation.app_id == service.appId` (registry join, never
   `startsWith`), operation app not disabled, else 403/404 per error model.
3. `commit|release`: load reservation; same-user foreign reservations stay 404
   (no app leak); same-user cross-app reservations are 403 via
   `reservation.operation → app` vs `service.app`.
4. USER comes only from the session, APP only from the credential, cost only
   from the registry. Bodies carry no userId/app.

## SERVER BRIDGE

- Browser cookie cannot cross `*.vercel.app` origins by construction — hence
  the backend bridge (ADR-013). The app backend forwards raw initData +
  service credential, stores the returned app token in its OWN HttpOnly cookie,
  and forwards `Authorization + X-Platform-Session` on credit calls.
- `ServerPlatformClient` (`@user-platform/platform-client/server`) is the
  sanctioned path: `serviceAuth.exchangePlatform(...)` + `credits.*` +
  `me.*` with injected `getServiceToken()`. The browser `PlatformClient`
  never calls the service exchange. Raw initData/session/service secrets are
  never logged, persisted, or returned to browsers.

## TOKEN ROTATION

Multiple active credentials per app: create B → deploy B to the app backend →
verify → revoke A (`service:revoke`). No global PREVIOUS token. Tests prove
A+B work, then A fails and B works after revocation.

## Threat model (critic-verified)

| Attack                                                                            | Result                                         |
| --------------------------------------------------------------------------------- | ---------------------------------------------- |
| Missing/garbage/malformed/overlong service token                                  | 401, no DB scan info                           |
| Valid keyId + wrong secret, unknown keyId                                         | 401 indistinguishable                          |
| Revoked / expired credential                                                      | 401 immediately                                |
| Disabled app (service or operation)                                               | 403                                            |
| `fridge` credential spending `wardrobe.*`                                         | 403                                            |
| `wardrobe` credential + `fridge` session                                          | 403                                            |
| Cross-service commit/release (same user, foreign reservation)                     | 403                                            |
| Cross-user commit/release                                                         | 404 (no app leak)                              |
| Account session on credit route                                                   | 403                                            |
| Expired/deleted/random session                                                    | 401                                            |
| Suspended user                                                                    | 403                                            |
| `startParam: "wardrobe"` with fridge credential                                   | still fridge (ignored for identity)            |
| Browser exchange JSON                                                             | never contains a raw token (regression-pinned) |
| Raw initData / service secret / session token in logs, DB, errors, snapshots, git | absent (grep-guarded; DB keeps hashes only)    |

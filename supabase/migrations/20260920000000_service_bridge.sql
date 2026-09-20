-- Gauntlet 1 service bridge: per-app credentials + app-scoped sessions.
-- Backwards-safe: existing session rows become account sessions (app_id NULL).
-- No data loss: only ADD TABLE / ADD COLUMN, never DROP existing auth data.
-- Lock risk: brief ACCESS EXCLUSIVE on sessions during ADD COLUMN with DEFAULT
-- (small table, acceptable); service_credentials is new (no lock concern).
-- Rollback: DROP TABLE service_credentials; ALTER TABLE sessions DROP CONSTRAINT
-- sessions_type_app_check; DROP COLUMN app_id, session_type, id (id drop last).

-- ---------- per-application service credentials ----------
create table service_credentials (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references apps (id) on delete restrict,
  key_id text not null unique check (key_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  secret_hash text not null,
  label text,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
create index service_credentials_app_id_idx on service_credentials (app_id);
create index service_credentials_status_idx on service_credentials (status);
alter table service_credentials enable row level security;

-- ---------- app-scoped sessions ----------
-- Existing rows: session_type defaults to 'account', app_id stays NULL → the
-- CHECK below keeps them valid, so production account sessions survive.
alter table sessions
  add column id uuid not null default gen_random_uuid() unique,
  add column session_type text not null default 'account'
    check (session_type in ('account', 'app')),
  add column app_id uuid references apps (id) on delete cascade;

alter table sessions
  add constraint sessions_type_app_check check (
    (session_type = 'account' and app_id is null)
    or (session_type = 'app' and app_id is not null)
  );

create index sessions_app_id_idx on sessions (app_id);

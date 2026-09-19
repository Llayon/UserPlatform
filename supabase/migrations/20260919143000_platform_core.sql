-- UserPlatform initial schema (Phase 1 design artifact — NOT YET APPLIED).
-- Apply only to a real Supabase/PostgreSQL project (see SUPABASE SETUP CHECKPOINT).
-- Conventions: UUID PKs, created_at/updated_at UTC, money as integer credits,
-- balances never negative (CHECK), uniqueness enforced in the DB (not app code).

create extension if not exists "pgcrypto";

-- ---------- identity ----------
create table users (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  provider text not null check (provider in ('telegram', 'max', 'web', 'google', 'email', 'apple')),
  provider_user_id text not null,
  provider_username text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (provider, provider_user_id)
);
create index user_identities_user_id_idx on user_identities (user_id);

create table profiles (
  user_id uuid primary key references users (id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  locale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

-- ---------- registry ----------
create table apps (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  status text not null default 'active' check (status in ('active', 'coming_soon', 'disabled')),
  created_at timestamptz not null default now()
);

create table operations (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references apps (id),
  operation_key text not null,
  credit_cost integer not null check (credit_cost >= 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (app_id, operation_key)
);

-- ---------- credits (ledger is the source of truth) ----------
create table credit_wallets (
  user_id uuid primary key references users (id) on delete cascade,
  available_balance integer not null default 0 check (available_balance >= 0),
  reserved_balance integer not null default 0 check (reserved_balance >= 0),
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

create table reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  operation_id uuid references operations (id),
  amount integer not null check (amount >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'committed', 'released')),
  request_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, request_id)
);
create index reservations_user_status_idx on reservations (user_id, status);

create table credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  delta integer not null,
  balance_after integer not null,
  app_id uuid references apps (id),
  operation_id uuid references operations (id),
  reservation_id uuid references reservations (id),
  reason text not null,
  idempotency_key text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index credit_ledger_user_created_idx on credit_ledger (user_id, created_at desc);

-- ---------- usage + entitlements (product history, NOT observability) ----------
create table usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  app_id uuid references apps (id),
  operation text not null,
  request_id text not null,
  status text not null check (status in ('reserved', 'committed', 'released', 'failed')),
  latency_ms integer,
  created_at timestamptz not null default now()
);
create index usage_events_user_created_idx on usage_events (user_id, created_at desc);

create table entitlements (
  user_id uuid not null references users (id) on delete cascade,
  key text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------- row level security (deny by default) ----------
-- Platform API uses the service-role key server-side and never exposes
-- Supabase anon access to these tables. Enabling RLS with no public policies
-- guarantees that even if anon credentials leak, no rows are readable or
-- writable through the Supabase Data API. All access goes through the API.
alter table users enable row level security;
alter table user_identities enable row level security;
alter table profiles enable row level security;
alter table sessions enable row level security;
alter table apps enable row level security;
alter table operations enable row level security;
alter table credit_wallets enable row level security;
alter table reservations enable row level security;
alter table credit_ledger enable row level security;
alter table usage_events enable row level security;
alter table entitlements enable row level security;

-- ---------- lookup indexes ----------
create index usage_events_request_id_idx on usage_events (request_id);

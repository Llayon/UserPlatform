-- Acquisition attribution (first-seen per user+platform).
-- Telemetry only: start_param is sanitized by parseStartParam() before insert
-- and never executed as route/code/URL.
create table user_acquisitions (
  user_id uuid not null references users (id) on delete cascade,
  provider text not null check (provider in ('telegram', 'max', 'web', 'google', 'email', 'apple')),
  start_param text not null default '',
  first_seen_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table user_acquisitions enable row level security;

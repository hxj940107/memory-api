create table if not exists public.moment_interaction_state (
  user_id text primary key,
  read_at timestamptz not null default '1970-01-01T00:00:00Z',
  updated_at timestamptz not null default now()
);

create index if not exists moment_interaction_state_updated_at_idx
on public.moment_interaction_state (updated_at desc);

create table if not exists public.moment_autonomous_state (
  user_id text primary key,
  next_consider_at timestamptz not null,
  last_considered_at timestamptz,
  last_outcome text,
  consecutive_declines integer not null default 0 check (consecutive_declines >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.moment_candidates
  add column if not exists consideration_mode text;
alter table public.moment_candidates
  add column if not exists source_type text;
alter table public.moment_candidates
  add column if not exists source_ref text;
alter table public.moment_candidates
  add column if not exists narrative_permission text;

alter table public.moment_entries
  add column if not exists consideration_mode text;
alter table public.moment_entries
  add column if not exists source_type text;
alter table public.moment_entries
  add column if not exists source_ref text;
alter table public.moment_entries
  add column if not exists narrative_permission text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'moment_candidates_consideration_mode_check'
  ) then
    alter table public.moment_candidates
      add constraint moment_candidates_consideration_mode_check
      check (consideration_mode is null or consideration_mode in ('chat', 'manual', 'autonomous'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'moment_candidates_narrative_permission_check'
  ) then
    alter table public.moment_candidates
      add constraint moment_candidates_narrative_permission_check
      check (
        narrative_permission is null or narrative_permission in (
          'shared_life', 'user_with_third_party', 'xiaoc_independent', 'uncertain'
        )
      );
  end if;
end $$;

revoke all on table public.moment_autonomous_state from public, anon, authenticated;
grant select, insert, update, delete on table public.moment_autonomous_state to service_role;

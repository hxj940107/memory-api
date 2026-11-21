-- Additive opt-in experiment; never changes memory_items or chat data.
BEGIN;
create table if not exists public.memory_association_cues (
  user_id text not null,
  memory_id uuid not null,
  content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
  policy_version text not null check(policy_version='association-shadow-v1'),
  status text not null check(status in ('processing','ready','failed')),
  cues jsonb not null default '[]' check(jsonb_typeof(cues)='array' and jsonb_array_length(cues)<=2),
  embedding_identity jsonb,
  created_at timestamptz not null default now(),
  primary key(user_id,memory_id),
  foreign key(user_id,memory_id) references public.memory_items(user_id,id)
);
alter table public.memory_association_cues enable row level security;
revoke all on public.memory_association_cues from public,anon,authenticated;
grant select,insert,update on public.memory_association_cues to service_role;
create or replace function public.guard_memory_association_trial() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('association-shadow:'||new.user_id,0));
  if (select count(*) from public.memory_association_cues where user_id=new.user_id)>=20 then
    raise exception 'ASSOCIATION_TRIAL_CAP';
  end if;
  if not exists(select 1 from public.memory_items where user_id=new.user_id and id=new.memory_id
    and content_hash=new.content_hash and origin_system='xiaoc_native' and lifecycle_status='active'
    and authority_tier='native_verified' and provenance_status in ('verified_user','derived_verified','manual_confirmed')
    and category in ('meaningful_experience','relationship_memory')) then raise exception 'ASSOCIATION_SOURCE_INELIGIBLE'; end if;
  return new;
end $$;
drop trigger if exists memory_association_trial_guard on public.memory_association_cues;
create trigger memory_association_trial_guard before insert on public.memory_association_cues
for each row execute function public.guard_memory_association_trial();
revoke all on function public.guard_memory_association_trial() from public,anon,authenticated;
COMMIT;

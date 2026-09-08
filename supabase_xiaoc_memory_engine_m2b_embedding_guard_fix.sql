-- XiaoC Memory Engine M2B corrective migration.
-- Fixes pgvector comparison in the embedding lifecycle guard only.
-- Does not read or modify Memory rows.

begin;

create or replace function public.xiaoc_memory_guard_embedding_transition()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.memory_id is distinct from old.memory_id
    or new.provider is distinct from old.provider
    or new.model is distinct from old.model
    or new.embedding_version is distinct from old.embedding_version
    or new.preprocessor_version is distinct from old.preprocessor_version
    or new.dimensions is distinct from old.dimensions
    or new.content_hash is distinct from old.content_hash
    or new.embedding::text is distinct from old.embedding::text
    or new.created_at is distinct from old.created_at
  then
    raise exception 'embedding identity/vector fields cannot be changed';
  end if;
  if not (
    (old.rollout_status = 'shadow' and new.rollout_status in ('active', 'stale'))
    or (old.rollout_status = 'active' and new.rollout_status in ('retired', 'stale'))
    or (old.rollout_status = new.rollout_status)
  ) then
    raise exception 'invalid embedding lifecycle transition';
  end if;
  return new;
end;
$$;

commit;

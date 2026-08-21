alter table public.conversation_summary
  add column if not exists core_memory_snapshot text,
  add column if not exists core_memory_snapshot_hash text,
  add column if not exists core_memory_snapshot_created_at timestamptz,
  add column if not exists core_memory_source_bucket_ids text[];

create or replace function public.initialize_core_memory_snapshot(
  p_conversation_id text,
  p_snapshot text,
  p_snapshot_hash text,
  p_source_bucket_ids text[],
  p_created_at timestamptz default now()
)
returns table (
  core_memory_snapshot text,
  core_memory_snapshot_hash text,
  core_memory_snapshot_created_at timestamptz,
  core_memory_source_bucket_ids text[]
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_conversation_id is null or btrim(p_conversation_id) = '' then
    raise exception 'conversation_id is required';
  end if;

  if p_snapshot is null or btrim(p_snapshot) = '' then
    raise exception 'core memory snapshot must not be empty';
  end if;

  if p_snapshot_hash is null or btrim(p_snapshot_hash) = '' then
    raise exception 'core memory snapshot hash is required';
  end if;

  if coalesce(array_length(p_source_bucket_ids, 1), 0) = 0 then
    raise exception 'core memory source bucket ids are required';
  end if;

  insert into public.conversation_summary (
    conversation_id,
    core_memory_snapshot,
    core_memory_snapshot_hash,
    core_memory_snapshot_created_at,
    core_memory_source_bucket_ids
  )
  values (
    p_conversation_id,
    p_snapshot,
    p_snapshot_hash,
    p_created_at,
    p_source_bucket_ids
  )
  on conflict (conversation_id) do update
  set
    core_memory_snapshot = excluded.core_memory_snapshot,
    core_memory_snapshot_hash = excluded.core_memory_snapshot_hash,
    core_memory_snapshot_created_at = excluded.core_memory_snapshot_created_at,
    core_memory_source_bucket_ids = excluded.core_memory_source_bucket_ids
  where conversation_summary.core_memory_snapshot is null
     or btrim(conversation_summary.core_memory_snapshot) = '';

  return query
  select
    cs.core_memory_snapshot,
    cs.core_memory_snapshot_hash,
    cs.core_memory_snapshot_created_at,
    cs.core_memory_source_bucket_ids
  from public.conversation_summary cs
  where cs.conversation_id = p_conversation_id;
end;
$$;

revoke all on function public.initialize_core_memory_snapshot(
  text,
  text,
  text,
  text[],
  timestamptz
) from public, anon, authenticated;

grant execute on function public.initialize_core_memory_snapshot(
  text,
  text,
  text,
  text[],
  timestamptz
) to service_role;

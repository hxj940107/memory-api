-- XiaoC Owned Memory lifecycle management (Shadow-only).
-- Additive and rollback-friendly: no existing rows are changed when this file is applied.

create or replace function public.xiaoc_memory_list_owned(
  p_user_id text,
  p_lifecycle_status text default 'active',
  p_limit integer default 100
)
returns table (
  id uuid,
  canonical_content text,
  memory_class text,
  category text,
  lifecycle_status text,
  importance smallint,
  confidence numeric,
  revision bigint,
  created_at timestamptz,
  updated_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_user_id is distinct from 'user' then raise exception 'OWNED_MEMORY_OWNER_MISMATCH'; end if;
  if p_lifecycle_status is null or p_lifecycle_status not in ('active', 'archived', 'deleted', 'all') then
    raise exception 'OWNED_MEMORY_INVALID_LIFECYCLE_STATUS';
  end if;
  return query select
    item.id, item.canonical_content, item.memory_class, item.category,
    item.lifecycle_status, item.importance, item.confidence, item.revision,
    item.created_at, item.updated_at, item.archived_at, item.deleted_at
  from public.memory_items item
  where item.user_id = p_user_id
    and item.origin_system = 'xiaoc_native'
    and p_lifecycle_status in ('active', 'archived', 'deleted', 'all')
    and (p_lifecycle_status = 'all' or item.lifecycle_status = p_lifecycle_status)
  order by item.updated_at desc, item.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200)
  ;
end;
$$;

create or replace function public.xiaoc_memory_archive_owned(
  p_user_id text,
  p_memory_id uuid,
  p_policy_version text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_operation_id uuid;
  v_memory public.memory_items%rowtype;
  v_before_status text;
  v_result jsonb;
begin
  if p_user_id is distinct from 'user' then raise exception 'OWNED_MEMORY_OWNER_MISMATCH'; end if;
  if nullif(btrim(p_policy_version), '') is null or nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'OWNED_MEMORY_OPERATION_IDENTITY_REQUIRED';
  end if;
  insert into public.memory_operations (
    user_id, operation_type, idempotency_key, actor_type, policy_version
  ) values (p_user_id, 'archive_owned', p_idempotency_key, 'user', p_policy_version)
  on conflict (user_id, operation_type, idempotency_key) do nothing
  returning id into v_operation_id;
  if v_operation_id is null then
    select after_state into v_result from public.memory_operations
    where user_id = p_user_id and operation_type = 'archive_owned'
      and idempotency_key = p_idempotency_key and result_status = 'success';
    if v_result is null then raise exception 'OWNED_MEMORY_OPERATION_IN_PROGRESS_OR_FAILED'; end if;
    return v_result;
  end if;

  select * into v_memory from public.memory_items
  where user_id = p_user_id and id = p_memory_id and origin_system = 'xiaoc_native'
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'OWNED_MEMORY_NOT_FOUND'; end if;
  if v_memory.lifecycle_status = 'deleted' then raise exception 'OWNED_MEMORY_ALREADY_DELETED'; end if;
  if v_memory.lifecycle_status = 'superseded' then raise exception 'OWNED_MEMORY_SUPERSEDED'; end if;
  v_before_status := v_memory.lifecycle_status;

  if v_before_status = 'active' then
    update public.memory_items set
      lifecycle_status = 'archived', archived_at = now(), revision = revision + 1, updated_at = now()
    where user_id = p_user_id and id = p_memory_id
    returning * into v_memory;
  end if;
  v_result := jsonb_build_object(
    'memory_id', v_memory.id, 'lifecycle_status', v_memory.lifecycle_status,
    'revision', v_memory.revision, 'changed', v_before_status = 'active'
  );
  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, array[p_memory_id],
    jsonb_build_object('lifecycle_status', v_before_status), v_result
  );
  return v_result;
end;
$$;

create or replace function public.xiaoc_memory_delete_owned(
  p_user_id text,
  p_memory_id uuid,
  p_policy_version text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_operation_id uuid;
  v_memory public.memory_items%rowtype;
  v_before_status text;
  v_result jsonb;
begin
  if p_user_id is distinct from 'user' then raise exception 'OWNED_MEMORY_OWNER_MISMATCH'; end if;
  if nullif(btrim(p_policy_version), '') is null or nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'OWNED_MEMORY_OPERATION_IDENTITY_REQUIRED';
  end if;
  insert into public.memory_operations (
    user_id, operation_type, idempotency_key, actor_type, policy_version
  ) values (p_user_id, 'delete_owned', p_idempotency_key, 'user', p_policy_version)
  on conflict (user_id, operation_type, idempotency_key) do nothing
  returning id into v_operation_id;
  if v_operation_id is null then
    select after_state into v_result from public.memory_operations
    where user_id = p_user_id and operation_type = 'delete_owned'
      and idempotency_key = p_idempotency_key and result_status = 'success';
    if v_result is null then raise exception 'OWNED_MEMORY_OPERATION_IN_PROGRESS_OR_FAILED'; end if;
    return v_result;
  end if;

  select * into v_memory from public.memory_items
  where user_id = p_user_id and id = p_memory_id and origin_system = 'xiaoc_native'
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'OWNED_MEMORY_NOT_FOUND'; end if;
  v_before_status := v_memory.lifecycle_status;
  if v_before_status = 'superseded' then raise exception 'OWNED_MEMORY_SUPERSEDED'; end if;
  if v_before_status <> 'deleted' then
    update public.memory_items set
      lifecycle_status = 'deleted', deleted_at = now(), revision = revision + 1, updated_at = now()
    where user_id = p_user_id and id = p_memory_id
    returning * into v_memory;
  end if;
  v_result := jsonb_build_object(
    'memory_id', v_memory.id, 'lifecycle_status', v_memory.lifecycle_status,
    'revision', v_memory.revision, 'changed', v_before_status <> 'deleted'
  );
  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, array[p_memory_id],
    jsonb_build_object('lifecycle_status', v_before_status), v_result
  );
  return v_result;
end;
$$;

create or replace function public.xiaoc_memory_clear_owned_active(
  p_user_id text,
  p_policy_version text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_operation_id uuid;
  v_memory_ids uuid[];
  v_affected_count integer;
  v_result jsonb;
begin
  if p_user_id is distinct from 'user' then raise exception 'OWNED_MEMORY_OWNER_MISMATCH'; end if;
  if nullif(btrim(p_policy_version), '') is null or nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'OWNED_MEMORY_OPERATION_IDENTITY_REQUIRED';
  end if;
  insert into public.memory_operations (
    user_id, operation_type, idempotency_key, actor_type, policy_version
  ) values (p_user_id, 'clear_owned_active', p_idempotency_key, 'user', p_policy_version)
  on conflict (user_id, operation_type, idempotency_key) do nothing
  returning id into v_operation_id;
  if v_operation_id is null then
    select after_state into v_result from public.memory_operations
    where user_id = p_user_id and operation_type = 'clear_owned_active'
      and idempotency_key = p_idempotency_key and result_status = 'success';
    if v_result is null then raise exception 'OWNED_MEMORY_OPERATION_IN_PROGRESS_OR_FAILED'; end if;
    return v_result;
  end if;

  with changed as (
    update public.memory_items set
      lifecycle_status = 'deleted', deleted_at = now(), revision = revision + 1, updated_at = now()
    where user_id = p_user_id and origin_system = 'xiaoc_native' and lifecycle_status = 'active'
    returning id
  )
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into v_memory_ids from changed;
  v_affected_count := coalesce(array_length(v_memory_ids, 1), 0);
  v_result := jsonb_build_object('affected_count', v_affected_count, 'lifecycle_status', 'deleted');
  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, v_memory_ids,
    jsonb_build_object('active_count', v_affected_count), v_result
  );
  return v_result;
end;
$$;

revoke all on function public.xiaoc_memory_list_owned(text, text, integer) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_archive_owned(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_delete_owned(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_clear_owned_active(text, text, text) from public, anon, authenticated;

grant execute on function public.xiaoc_memory_list_owned(text, text, integer) to service_role;
grant execute on function public.xiaoc_memory_archive_owned(text, uuid, text, text) to service_role;
grant execute on function public.xiaoc_memory_delete_owned(text, uuid, text, text) to service_role;
grant execute on function public.xiaoc_memory_clear_owned_active(text, text, text) to service_role;

-- Rollback, if needed before runtime adoption: revoke service_role EXECUTE, then DROP the
-- four functions by the exact signatures above. No table or row rollback is required.

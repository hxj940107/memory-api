-- Memory Library V1: allow the existing protected delete lifecycle to cover
-- only canonical memories that may participate in owned-authoritative retrieval.

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
  where user_id = p_user_id and id = p_memory_id and (
    (
      origin_system = 'xiaoc_native'
      and provenance_status in ('verified_user', 'manual_confirmed', 'derived_verified')
      and retrieval_tier is null and authority_tier = 'native_verified'
    ) or (
      origin_system = 'ombre_legacy' and provenance_status = 'legacy_unverified'
      and retrieval_tier in ('active_legacy', 'low_authority')
      and authority_tier = 'legacy_limited'
    )
  ) for update;
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

revoke all on function public.xiaoc_memory_delete_owned(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.xiaoc_memory_delete_owned(text, uuid, text, text) to service_role;

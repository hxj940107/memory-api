-- XiaoC Memory Library owned management.
-- Additive schema only: applying this file does not mutate any Memory row.

create or replace function public.xiaoc_memory_edit_owned(
  p_user_id text,
  p_memory_id uuid,
  p_canonical_content text,
  p_category text,
  p_expected_revision bigint,
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
  v_old public.memory_items%rowtype;
  v_new_id uuid;
  v_content text := btrim(coalesce(p_canonical_content, ''));
  v_content_hash text;
  v_pin public.memory_pins%rowtype;
  v_replay public.memory_items%rowtype;
  v_replay_pinned boolean;
  v_existing jsonb;
  v_result jsonb;
begin
  if p_user_id is distinct from 'user' then raise exception 'OWNED_MEMORY_OWNER_MISMATCH'; end if;
  if p_memory_id is null then raise exception 'OWNED_MEMORY_ID_REQUIRED'; end if;
  if v_content = '' then raise exception 'OWNED_MEMORY_CONTENT_REQUIRED'; end if;
  if length(v_content) > 50000 then raise exception 'OWNED_MEMORY_CONTENT_TOO_LONG'; end if;
  if p_category not in (
    'personal_fact', 'relationship_memory',
    'meaningful_experience', 'relationship_preference'
  ) then raise exception 'OWNED_MEMORY_CATEGORY_INVALID'; end if;
  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'OWNED_MEMORY_REVISION_REQUIRED';
  end if;
  if nullif(btrim(p_policy_version), '') is null
    or nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'OWNED_MEMORY_OPERATION_IDENTITY_REQUIRED';
  end if;

  select after_state into v_existing
  from public.memory_operations
  where user_id = p_user_id and operation_type = 'manual_edit_owned'
    and idempotency_key = p_idempotency_key and result_status = 'success';
  if v_existing is not null then
    select * into v_replay from public.memory_items
    where user_id = p_user_id and id = (v_existing->>'memory_id')::uuid;
    if not found then raise exception 'OWNED_MEMORY_IDEMPOTENT_RESULT_MISSING'; end if;
    select exists(
      select 1 from public.memory_pins where user_id = p_user_id
        and memory_id = v_replay.id and scope = 'core' and pin_status = 'active'
    ) into v_replay_pinned;
    return v_existing || jsonb_build_object(
      'canonical_content', v_replay.canonical_content,
      'content_hash', v_replay.content_hash,
      'category', v_replay.category,
      'revision', v_replay.revision,
      'pinned', v_replay_pinned
    );
  end if;

  select * into v_old
  from public.memory_items
  where user_id = p_user_id and id = p_memory_id and lifecycle_status = 'active'
    and (
      (origin_system = 'xiaoc_native'
        and provenance_status in ('verified_user', 'manual_confirmed', 'derived_verified')
        and retrieval_tier is null and authority_tier = 'native_verified')
      or
      (origin_system = 'ombre_legacy' and provenance_status = 'legacy_unverified'
        and retrieval_tier in ('active_legacy', 'low_authority')
        and authority_tier = 'legacy_limited')
    )
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'OWNED_MEMORY_NOT_FOUND'; end if;
  if v_old.revision <> p_expected_revision then raise exception 'OWNED_MEMORY_STALE_REVISION'; end if;

  insert into public.memory_operations (
    user_id, operation_type, idempotency_key, actor_type, policy_version
  ) values (
    p_user_id, 'manual_edit_owned', p_idempotency_key, 'user', p_policy_version
  )
  on conflict (user_id, operation_type, idempotency_key) do nothing
  returning id into v_operation_id;
  if v_operation_id is null then
    select after_state into v_existing
    from public.memory_operations
    where user_id = p_user_id and operation_type = 'manual_edit_owned'
      and idempotency_key = p_idempotency_key and result_status = 'success';
    if v_existing is null then raise exception 'OWNED_MEMORY_OPERATION_IN_PROGRESS_OR_FAILED'; end if;
    select * into v_replay from public.memory_items
    where user_id = p_user_id and id = (v_existing->>'memory_id')::uuid;
    if not found then raise exception 'OWNED_MEMORY_IDEMPOTENT_RESULT_MISSING'; end if;
    select exists(
      select 1 from public.memory_pins where user_id = p_user_id
        and memory_id = v_replay.id and scope = 'core' and pin_status = 'active'
    ) into v_replay_pinned;
    return v_existing || jsonb_build_object(
      'canonical_content', v_replay.canonical_content,
      'content_hash', v_replay.content_hash,
      'category', v_replay.category,
      'revision', v_replay.revision,
      'pinned', v_replay_pinned
    );
  end if;

  v_new_id := extensions.gen_random_uuid();
  v_content_hash := encode(extensions.digest(convert_to(v_content, 'UTF8'), 'sha256'), 'hex');

  insert into public.memory_items (
    id, user_id, canonical_content, content_hash, origin_system, memory_class,
    category, provenance_status, lifecycle_status, retrieval_tier, authority_tier,
    authority_policy_version, claim_key, importance, confidence, event_time,
    valid_from, valid_until, capture_policy_version, metadata
  ) values (
    v_new_id, p_user_id, v_content, v_content_hash, 'xiaoc_native', v_old.memory_class,
    p_category, 'manual_confirmed', 'active', null, 'native_verified',
    p_policy_version, null, v_old.importance, null, v_old.event_time,
    v_old.valid_from, v_old.valid_until, p_policy_version,
    jsonb_build_object('manual_edit_source_memory_id', v_old.id)
  );

  insert into public.memory_provenance (
    user_id, memory_id, source_kind, source_locator_key, source_operation_id,
    source_role, evidence_text, evidence_hash, evidence_type, observed_at
  ) values (
    p_user_id, v_new_id, 'manual_user', 'manual:' || v_operation_id::text,
    v_operation_id, 'user', v_content, v_content_hash, 'correction', now()
  );

  insert into public.memory_relations (
    user_id, from_memory_id, to_memory_id, relation_type, operation_id
  ) values (
    p_user_id, v_new_id, v_old.id, 'supersedes', v_operation_id
  );

  select * into v_pin
  from public.memory_pins
  where user_id = p_user_id and memory_id = v_old.id
    and scope = 'core' and pin_status = 'active'
  for update;

  update public.memory_items set
    lifecycle_status = 'superseded', superseded_at = now(),
    revision = revision + 1, updated_at = now()
  where user_id = p_user_id and id = v_old.id;

  update public.memory_embeddings set rollout_status = 'stale'
  where user_id = p_user_id and memory_id = v_old.id
    and rollout_status in ('active', 'shadow');

  if v_pin.id is not null then
    update public.memory_pins set
      pin_status = 'inactive', operation_id = v_operation_id, unpinned_at = now()
    where user_id = p_user_id and id = v_pin.id;
    insert into public.memory_pins (
      user_id, memory_id, scope, ordinal, pin_status, pinned_by,
      operation_id, pinned_at, unpinned_at
    ) values (
      p_user_id, v_new_id, 'core', v_pin.ordinal, 'active', 'user',
      v_operation_id, now(), null
    );
  end if;

  v_result := jsonb_build_object(
    'memory_id', v_new_id,
    'replaced_memory_id', v_old.id,
    'canonical_content', v_content,
    'content_hash', v_content_hash,
    'category', p_category,
    'revision', 1,
    'pinned', v_pin.id is not null,
    'changed', true
  );
  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, array[v_old.id, v_new_id],
    jsonb_build_object(
      'memory_id', v_old.id, 'revision', v_old.revision,
      'category', v_old.category, 'content_hash', v_old.content_hash,
      'pinned', v_pin.id is not null
    ),
    v_result - 'canonical_content'
  );
  return v_result;
end;
$$;

revoke all on function public.xiaoc_memory_edit_owned(
  text, uuid, text, text, bigint, text, text
) from public, anon, authenticated;
grant execute on function public.xiaoc_memory_edit_owned(
  text, uuid, text, text, bigint, text, text
) to service_role;

-- Rollback before runtime use:
-- revoke execute on function public.xiaoc_memory_edit_owned(text, uuid, text, text, bigint, text, text) from service_role;
-- drop function public.xiaoc_memory_edit_owned(text, uuid, text, text, bigint, text, text);

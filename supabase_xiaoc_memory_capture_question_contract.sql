begin;

create or replace function public.xiaoc_memory_capture_verified(
  p_user_id text,
  p_source_message_id uuid,
  p_source_conversation_id text,
  p_evidence_text text,
  p_evidence_type text,
  p_canonical_content text,
  p_memory_class text,
  p_category text,
  p_claim_key text,
  p_event_time timestamptz,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_importance smallint,
  p_confidence numeric,
  p_capture_policy_version text,
  p_authority_policy_version text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_operation_id uuid;
  v_memory_id uuid;
  v_message record;
  v_content_hash text;
  v_evidence_hash text;
begin
  if p_evidence_type is null or p_evidence_type not in (
    'assertion', 'confirmation', 'correction', 'question', 'other'
  ) then
    raise exception 'unsupported evidence type';
  end if;
  select id, user_id, conversation_id, role, content, created_at into v_message
  from public.messages where id = p_source_message_id;
  if not found or v_message.user_id <> p_user_id or v_message.role <> 'user'
     or v_message.conversation_id is distinct from p_source_conversation_id
     or position(p_evidence_text in v_message.content) = 0 then
    raise exception 'invalid or cross-user message provenance';
  end if;

  insert into public.memory_operations (
    user_id, operation_type, idempotency_key, actor_type, policy_version
  ) values (
    p_user_id, 'capture_verified', p_idempotency_key, 'system', p_capture_policy_version
  ) on conflict (user_id, operation_type, idempotency_key) do nothing
  returning id into v_operation_id;
  if v_operation_id is null then
    select (affected_memory_ids)[1] into v_memory_id from public.memory_operations
    where user_id = p_user_id and operation_type = 'capture_verified'
      and idempotency_key = p_idempotency_key and result_status = 'success';
    if v_memory_id is null then raise exception 'capture operation already in progress or failed'; end if;
    return v_memory_id;
  end if;

  v_memory_id := extensions.gen_random_uuid();
  v_content_hash := encode(extensions.digest(convert_to(p_canonical_content, 'UTF8'), 'sha256'), 'hex');
  v_evidence_hash := encode(extensions.digest(convert_to(p_evidence_text, 'UTF8'), 'sha256'), 'hex');
  insert into public.memory_items (
    id, user_id, canonical_content, content_hash, origin_system, memory_class,
    category, provenance_status, lifecycle_status, retrieval_tier, authority_tier,
    authority_policy_version, claim_key, importance, confidence, event_time,
    valid_from, valid_until, capture_policy_version
  ) values (
    v_memory_id, p_user_id, p_canonical_content, v_content_hash, 'xiaoc_native', p_memory_class,
    p_category, 'verified_user', 'active', null, 'native_verified',
    p_authority_policy_version, p_claim_key, p_importance, p_confidence, p_event_time,
    p_valid_from, p_valid_until, p_capture_policy_version
  );
  insert into public.memory_provenance (
    user_id, memory_id, source_kind, source_locator_key, source_message_id,
    source_conversation_id, source_role, evidence_text, evidence_hash,
    evidence_type, observed_at
  ) values (
    p_user_id, v_memory_id, 'message', 'message:' || p_source_message_id::text,
    p_source_message_id, p_source_conversation_id, 'user', p_evidence_text,
    v_evidence_hash, p_evidence_type, v_message.created_at
  );
  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, array[v_memory_id]
  );
  return v_memory_id;
end;
$$;

commit;

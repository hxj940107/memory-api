-- Protected, reversible activation for manually reviewed Ombre historical rows.
create or replace function public.xiaoc_memory_activate_historical_shadow(
  p_user_id text,
  p_manifest_digest text,
  p_policy_version text,
  p_entries jsonb,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_operation_id uuid;
  v_entry jsonb;
  v_item public.memory_items%rowtype;
  v_map public.legacy_memory_map%rowtype;
  v_ids uuid[] := '{}'::uuid[];
  v_before jsonb := '[]'::jsonb;
  v_after jsonb := '[]'::jsonb;
  v_required text[] := array[
    'MANUAL_CONTENT_REVIEW_APPROVED', 'HISTORICAL_EPISODIC_REVIEW_APPROVED',
    'NON_SENSITIVE_REVIEW_CONFIRMED', 'NON_MUTABLE_REVIEW_CONFIRMED'
  ];
  v_computed_digest text;
begin
  if p_manifest_digest !~ '^[0-9a-f]{64}$' or p_policy_version <> 'xiaoc-historical-shadow-activation-v1'
    or p_idempotency_key <> 'historical-shadow-activate:' || p_manifest_digest then
    raise exception 'invalid activation contract';
  end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) < 1 or jsonb_array_length(p_entries) > 95 then
    raise exception 'activation manifest must contain 1..95 entries';
  end if;
  if (select count(*) from jsonb_array_elements(p_entries)) <>
     (select count(distinct value->>'memory_id') from jsonb_array_elements(p_entries)) then
    raise exception 'duplicate activation identity';
  end if;
  select encode(extensions.digest(convert_to(string_agg(concat_ws(chr(31),
    value->>'user_id', value->>'memory_id', value->>'legacy_external_id', value->>'content_hash',
    value->>'expected_revision', value->>'expected_retrieval_tier', value->>'expected_authority_tier',
    value->>'expected_lifecycle_status',
    (select string_agg(code, ',' order by code) from jsonb_array_elements_text(value->'review_reason_codes') code),
    value->>'target_retrieval_tier', value->>'target_authority_tier'
  ), chr(30) order by value->>'memory_id'), 'UTF8'), 'sha256'), 'hex') into v_computed_digest
  from jsonb_array_elements(p_entries);
  if v_computed_digest is distinct from p_manifest_digest then
    raise exception 'activation manifest digest mismatch';
  end if;

  select id into v_operation_id from public.memory_operations
  where user_id=p_user_id and operation_type='historical_shadow_activate'
    and idempotency_key=p_idempotency_key and result_status='success';
  if v_operation_id is not null then return v_operation_id; end if;

  for v_entry in select value from jsonb_array_elements(p_entries) loop
    if v_entry->>'user_id' is distinct from p_user_id
      or v_entry->>'expected_retrieval_tier' is distinct from 'shadow_only'
      or v_entry->>'expected_authority_tier' is distinct from 'none'
      or v_entry->>'expected_lifecycle_status' is distinct from 'active'
      or v_entry->>'target_retrieval_tier' is distinct from 'low_authority'
      or v_entry->>'target_authority_tier' is distinct from 'legacy_limited'
      or jsonb_typeof(v_entry->'review_reason_codes') is distinct from 'array'
      or coalesce((v_entry->'review_reason_codes') ?& v_required, false) is not true
      or coalesce(v_entry->>'expected_revision','') !~ '^[1-9][0-9]*$' then
      raise exception 'entry lacks locked manual review approval';
    end if;
    select * into v_item from public.memory_items
    where user_id=p_user_id and id=(v_entry->>'memory_id')::uuid for update;
    select * into v_map from public.legacy_memory_map
    where user_id=p_user_id and memory_id=(v_entry->>'memory_id')::uuid;
    if v_item.id is null or v_map.id is null
      or v_item.origin_system <> 'ombre_legacy' or v_item.provenance_status <> 'legacy_unverified'
      or v_item.retrieval_tier <> 'shadow_only' or v_item.authority_tier <> 'none'
      or v_item.lifecycle_status <> 'active' or v_item.revision <> (v_entry->>'expected_revision')::bigint
      or v_item.content_hash <> v_entry->>'content_hash'
      or v_map.legacy_external_id <> v_entry->>'legacy_external_id'
      or v_map.original_content_hash <> v_entry->>'content_hash'
      or coalesce(v_map.original_archive_state,'live') <> 'live'
      or v_map.legacy_pin_candidate
      or split_part(v_map.original_relative_path,'/',1) in ('archive','permanent','feel') then
      raise exception 'historical activation state mismatch';
    end if;
    v_ids := array_append(v_ids, v_item.id);
    v_before := v_before || jsonb_build_array(jsonb_build_object(
      'memory_id',v_item.id,'revision',v_item.revision,'retrieval_tier',v_item.retrieval_tier,'authority_tier',v_item.authority_tier));
  end loop;

  insert into public.memory_operations(user_id,operation_type,idempotency_key,actor_type,policy_version)
  values(p_user_id,'historical_shadow_activate',p_idempotency_key,'migration',p_policy_version)
  on conflict(user_id,operation_type,idempotency_key) do nothing returning id into v_operation_id;
  if v_operation_id is null then raise exception 'activation operation already in progress or failed'; end if;

  update public.memory_items set retrieval_tier='low_authority', authority_tier='legacy_limited',
    revision=revision+1, updated_at=now()
  where user_id=p_user_id and id=any(v_ids);
  select coalesce(jsonb_agg(jsonb_build_object(
    'memory_id',id,'revision',revision,'retrieval_tier',retrieval_tier,'authority_tier',authority_tier) order by id),'[]'::jsonb)
    into v_after from public.memory_items where user_id=p_user_id and id=any(v_ids);
  perform public.xiaoc_memory_finish_operation(
    p_user_id,v_operation_id,'success',null,v_ids,v_before,
    jsonb_build_object('manifest_digest',p_manifest_digest,'items',v_after));
  return v_operation_id;
end;
$$;

create or replace function public.xiaoc_memory_demote_historical_shadow(
  p_user_id text,
  p_manifest_digest text,
  p_policy_version text,
  p_entries jsonb,
  p_compensates_operation_id uuid,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_operation_id uuid;
  v_entry jsonb;
  v_item public.memory_items%rowtype;
  v_ids uuid[] := '{}'::uuid[];
  v_before jsonb := '[]'::jsonb;
  v_after jsonb := '[]'::jsonb;
begin
  if p_manifest_digest !~ '^[0-9a-f]{64}$' or p_policy_version <> 'xiaoc-historical-shadow-activation-v1'
    or p_idempotency_key <> 'historical-shadow-demote:' || p_manifest_digest
    or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) < 1
    or jsonb_array_length(p_entries) > 95 then
    raise exception 'invalid demotion contract';
  end if;
  if not exists(select 1 from public.memory_operations where user_id=p_user_id and id=p_compensates_operation_id
    and operation_type='historical_shadow_activate' and result_status='success'
    and after_state->>'manifest_digest'=p_manifest_digest
    and cardinality(affected_memory_ids)=jsonb_array_length(p_entries)
    and not exists(select 1 from jsonb_array_elements(p_entries) e
      where not ((e->>'memory_id')::uuid = any(affected_memory_ids)))) then
    raise exception 'successful activation operation required';
  end if;
  if (select count(*) from jsonb_array_elements(p_entries)) <>
     (select count(distinct value->>'memory_id') from jsonb_array_elements(p_entries)) then
    raise exception 'duplicate demotion identity';
  end if;

  select id into v_operation_id from public.memory_operations
  where user_id=p_user_id and operation_type='historical_shadow_demote'
    and idempotency_key=p_idempotency_key and result_status='success';
  if v_operation_id is not null then return v_operation_id; end if;

  for v_entry in select value from jsonb_array_elements(p_entries) loop
    if v_entry->>'user_id' is distinct from p_user_id
      or coalesce(v_entry->>'expected_revision','') !~ '^[1-9][0-9]*$'
      or coalesce(v_entry->>'content_hash','') !~ '^[0-9a-f]{64}$' then
      raise exception 'demotion identity invalid';
    end if;
    select * into v_item from public.memory_items
    where user_id=p_user_id and id=(v_entry->>'memory_id')::uuid for update;
    if v_item.id is null or v_item.origin_system <> 'ombre_legacy' or v_item.provenance_status <> 'legacy_unverified'
      or v_item.retrieval_tier <> 'low_authority' or v_item.authority_tier <> 'legacy_limited'
      or v_item.lifecycle_status <> 'active' or v_item.revision <> (v_entry->>'expected_revision')::bigint
      or v_item.content_hash <> v_entry->>'content_hash' then
      raise exception 'historical demotion state mismatch';
    end if;
    v_ids := array_append(v_ids,v_item.id);
    v_before := v_before || jsonb_build_array(jsonb_build_object(
      'memory_id',v_item.id,'revision',v_item.revision,'retrieval_tier',v_item.retrieval_tier,'authority_tier',v_item.authority_tier));
  end loop;

  insert into public.memory_operations(user_id,operation_type,idempotency_key,actor_type,policy_version,compensates_operation_id)
  values(p_user_id,'historical_shadow_demote',p_idempotency_key,'migration',p_policy_version,p_compensates_operation_id)
  on conflict(user_id,operation_type,idempotency_key) do nothing returning id into v_operation_id;
  if v_operation_id is null then raise exception 'demotion operation already in progress or failed'; end if;
  update public.memory_items set retrieval_tier='shadow_only',authority_tier='none',
    revision=revision+1,updated_at=now() where user_id=p_user_id and id=any(v_ids);
  select coalesce(jsonb_agg(jsonb_build_object(
    'memory_id',id,'revision',revision,'retrieval_tier',retrieval_tier,'authority_tier',authority_tier) order by id),'[]'::jsonb)
    into v_after from public.memory_items where user_id=p_user_id and id=any(v_ids);
  perform public.xiaoc_memory_finish_operation(
    p_user_id,v_operation_id,'success',null,v_ids,v_before,
    jsonb_build_object('manifest_digest',p_manifest_digest,'items',v_after));
  return v_operation_id;
end;
$$;

revoke all on function public.xiaoc_memory_activate_historical_shadow(text,text,text,jsonb,text) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_demote_historical_shadow(text,text,text,jsonb,uuid,text) from public, anon, authenticated;
grant execute on function public.xiaoc_memory_activate_historical_shadow(text,text,text,jsonb,text) to service_role;
grant execute on function public.xiaoc_memory_demote_historical_shadow(text,text,text,jsonb,uuid,text) to service_role;

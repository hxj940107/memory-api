-- Transactional synthetic validation. Never touches real historical identities.
begin;

insert into public.memory_import_runs (
  id,user_id,source_system,source_archive_sha256,importer_version,legacy_policy_version,
  run_status,source_file_count,planned_count,imported_count,rejected_count
) values (
  '91000000-0000-4000-8000-000000000001','__xiaoc_activation_validation__','ombre',repeat('a',64),
  'validation','validation','complete',1,1,1,0
);

insert into public.memory_items (
  id,user_id,canonical_content,content_hash,origin_system,memory_class,category,
  provenance_status,lifecycle_status,retrieval_tier,authority_tier,authority_policy_version,capture_policy_version
) values (
  '92000000-0000-4000-8000-000000000001','__xiaoc_activation_validation__','FICTITIOUS_ACTIVATION_MEMORY',
  encode(extensions.digest(convert_to('FICTITIOUS_ACTIVATION_MEMORY','UTF8'),'sha256'),'hex'),
  'ombre_legacy','observation','legacy_validation','legacy_unverified','active','shadow_only','none','validation','validation'
);

insert into public.legacy_memory_map (
  id,user_id,import_run_id,memory_id,source_system,legacy_external_id,original_relative_path,
  original_content,original_content_hash,legacy_pin_candidate,original_archive_state,legacy_policy_version,initial_retrieval_tier
) values (
  '93000000-0000-4000-8000-000000000001','__xiaoc_activation_validation__',
  '91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','ombre','abc123abc123',
  'dynamic/validation/FICTITIOUS_ACTIVATION_MEMORY-abc123abc123.md','FICTITIOUS_ACTIVATION_MEMORY',
  encode(extensions.digest(convert_to('FICTITIOUS_ACTIVATION_MEMORY','UTF8'),'sha256'),'hex'),false,'live','validation','shadow_only'
);

set local role service_role;

do $$
declare
  v_hash text := encode(extensions.digest(convert_to('FICTITIOUS_ACTIVATION_MEMORY','UTF8'),'sha256'),'hex');
  v_digest text;
  v_entries jsonb;
  v_activate uuid;
  v_demote uuid;
begin
  v_entries := jsonb_build_array(jsonb_build_object(
    'user_id','__xiaoc_activation_validation__','memory_id','92000000-0000-4000-8000-000000000001',
    'legacy_external_id','abc123abc123','content_hash',v_hash,'expected_revision',1,
    'expected_retrieval_tier','shadow_only','expected_authority_tier','none','expected_lifecycle_status','active',
    'review_reason_codes',jsonb_build_array('MANUAL_CONTENT_REVIEW_APPROVED','HISTORICAL_EPISODIC_REVIEW_APPROVED',
      'NON_SENSITIVE_REVIEW_CONFIRMED','NON_MUTABLE_REVIEW_CONFIRMED'),
    'target_retrieval_tier','low_authority','target_authority_tier','legacy_limited'));
  select encode(extensions.digest(convert_to(string_agg(concat_ws(chr(31),
    value->>'user_id', value->>'memory_id', value->>'legacy_external_id', value->>'content_hash',
    value->>'expected_revision', value->>'expected_retrieval_tier', value->>'expected_authority_tier',
    value->>'expected_lifecycle_status',
    (select string_agg(code, ',' order by code) from jsonb_array_elements_text(value->'review_reason_codes') code),
    value->>'target_retrieval_tier', value->>'target_authority_tier'
  ), chr(30) order by value->>'memory_id'), 'UTF8'), 'sha256'), 'hex') into v_digest
  from jsonb_array_elements(v_entries);
  v_activate := public.xiaoc_memory_activate_historical_shadow(
    '__xiaoc_activation_validation__',v_digest,'xiaoc-historical-shadow-activation-v1',v_entries,
    'historical-shadow-activate:'||v_digest);
  if not exists(select 1 from public.memory_items where user_id='__xiaoc_activation_validation__'
    and id='92000000-0000-4000-8000-000000000001' and retrieval_tier='low_authority'
    and authority_tier='legacy_limited' and provenance_status='legacy_unverified' and revision=2) then
    raise exception 'synthetic activation failed';
  end if;
  if public.xiaoc_memory_activate_historical_shadow(
    '__xiaoc_activation_validation__',v_digest,'xiaoc-historical-shadow-activation-v1',v_entries,
    'historical-shadow-activate:'||v_digest) <> v_activate then raise exception 'activation not idempotent'; end if;

  v_entries := jsonb_build_array(jsonb_build_object(
    'user_id','__xiaoc_activation_validation__','memory_id','92000000-0000-4000-8000-000000000001',
    'content_hash',v_hash,'expected_revision',2));
  v_demote := public.xiaoc_memory_demote_historical_shadow(
    '__xiaoc_activation_validation__',v_digest,'xiaoc-historical-shadow-activation-v1',v_entries,v_activate,
    'historical-shadow-demote:'||v_digest);
  if not exists(select 1 from public.memory_items where user_id='__xiaoc_activation_validation__'
    and id='92000000-0000-4000-8000-000000000001' and retrieval_tier='shadow_only'
    and authority_tier='none' and revision=3) then raise exception 'synthetic demotion failed'; end if;
  if not exists(select 1 from public.memory_operations where user_id='__xiaoc_activation_validation__'
    and id=v_demote and compensates_operation_id=v_activate and result_status='success') then
    raise exception 'compensating ledger missing';
  end if;

  begin
    perform public.xiaoc_memory_activate_historical_shadow(
      '__xiaoc_activation_validation__',repeat('c',64),'xiaoc-historical-shadow-activation-v1',
      jsonb_build_array(jsonb_build_object(
        'user_id','__xiaoc_activation_validation__','memory_id','92000000-0000-4000-8000-000000000001',
        'legacy_external_id','wrong','content_hash',repeat('d',64),'expected_revision',3,
        'expected_retrieval_tier','shadow_only','expected_authority_tier','none','expected_lifecycle_status','active',
        'review_reason_codes',jsonb_build_array('MANUAL_CONTENT_REVIEW_APPROVED','HISTORICAL_EPISODIC_REVIEW_APPROVED',
          'NON_SENSITIVE_REVIEW_CONFIRMED','NON_MUTABLE_REVIEW_CONFIRMED'),
        'target_retrieval_tier','low_authority','target_authority_tier','legacy_limited')),
      'historical-shadow-activate:'||repeat('c',64));
    raise exception 'mismatched identity unexpectedly activated';
  exception when others then
    if sqlerrm = 'mismatched identity unexpectedly activated' then raise; end if;
  end;
end;
$$;

rollback;

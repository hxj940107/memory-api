-- XiaoC Memory Engine M2D delta import for the 2026-09-21 locked Ombre snapshot.
-- Additive and exact-contract only. Does not change the completed 150-row M2D run.

create or replace function public.xiaoc_memory_create_delta_import_run(
  p_plan jsonb,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_run_id uuid;
  v_operation_id uuid;
  v_computed text;
  v_order text;
  v_namespace constant uuid := 'f1c7e436-ff13-5d2c-8e4a-5de7386b6db7';
  v_source_sha constant text := 'a6cc6820c7396af0eb8adc2c3b1c0a8596332beb946fbaf4bf93a86038d81e5d';
  v_manifest_sha constant text := 'a8f06f3746b17423bce0d409b9437fd8882b75c2d213cbce0e03e5826b60a15f';
  v_order_digest constant text := 'ff4b7d718afa1cf11e4c961860efe18e9d68718ce63b804427d6ab3687ff3e6f';
  v_class_digest constant text := '84db2db26c74441dcbe20d4df486b3bb30771f34c6b95a3b79b2221a96b386ba';
  v_policy constant text := 'xiaoc-historical-delta-v1';
  v_importer constant text := 'xiaoc-historical-delta-importer-v1';
begin
  if jsonb_typeof(p_plan) <> 'array' or jsonb_array_length(p_plan) <> 16
    or nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'locked M2D delta contract required';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_plan) x(
      ordinal int, legacy_external_id text, content_hash text,
      deterministic_memory_id uuid, retrieval_tier text,
      authority_tier text, reason_codes text[]
    )
    where ordinal is null or legacy_external_id !~ '^[0-9a-f]{12}$'
      or content_hash !~ '^[0-9a-f]{64}$'
      or deterministic_memory_id <> extensions.uuid_generate_v5(
        v_namespace, 'user' || chr(31) || 'ombre' || chr(31) || legacy_external_id
      )
      or retrieval_tier <> 'shadow_only' or authority_tier <> 'none'
      or cardinality(reason_codes) = 0
  ) then raise exception 'invalid delta classification plan item'; end if;
  if (select count(distinct legacy_external_id) from jsonb_to_recordset(p_plan) x(legacy_external_id text)) <> 16
    or (select count(distinct deterministic_memory_id) from jsonb_to_recordset(p_plan) x(deterministic_memory_id uuid)) <> 16
    or (select min(ordinal) <> 0 or max(ordinal) <> 15 or count(distinct ordinal) <> 16
        from jsonb_to_recordset(p_plan) x(ordinal int)) then
    raise exception 'delta plan identity or order mismatch';
  end if;
  select encode(extensions.digest(convert_to(string_agg(
    legacy_external_id || chr(31) || content_hash || chr(31) || deterministic_memory_id::text || chr(31) || retrieval_tier || chr(31) || authority_tier,
    chr(30) order by legacy_external_id collate "C"), 'UTF8'), 'sha256'), 'hex')
    into v_computed
  from jsonb_to_recordset(p_plan) x(
    legacy_external_id text, content_hash text, deterministic_memory_id uuid,
    retrieval_tier text, authority_tier text
  );
  if v_computed <> v_class_digest then raise exception 'delta classification digest mismatch'; end if;
  select encode(extensions.digest(convert_to(string_agg(
    ordinal::text || chr(31) || legacy_external_id || chr(31) || content_hash || chr(31) || deterministic_memory_id::text,
    chr(30) order by ordinal), 'UTF8'), 'sha256'), 'hex')
    into v_order
  from jsonb_to_recordset(p_plan) x(
    ordinal int, legacy_external_id text, content_hash text, deterministic_memory_id uuid
  );
  if v_order <> v_order_digest then raise exception 'delta execution order digest mismatch'; end if;

  insert into public.memory_import_runs(
    user_id, source_system, source_archive_sha256, importer_version,
    legacy_policy_version, source_file_count, planned_count, manifest_sha256,
    execution_order_digest, classification_digest, expected_record_count, policy_version
  ) values (
    'user', 'ombre', v_source_sha, v_importer, v_policy, 16, 16,
    v_manifest_sha, v_order_digest, v_class_digest, 16, v_policy
  )
  on conflict(user_id, source_system, source_archive_sha256, importer_version, legacy_policy_version)
    do nothing returning id into v_run_id;
  if v_run_id is null then
    select id into v_run_id from public.memory_import_runs
    where user_id = 'user' and source_system = 'ombre'
      and source_archive_sha256 = v_source_sha and importer_version = v_importer
      and legacy_policy_version = v_policy and manifest_sha256 = v_manifest_sha
      and execution_order_digest = v_order_digest and classification_digest = v_class_digest
      and expected_record_count = 16;
    if v_run_id is null then raise exception 'existing delta run has a different immutable contract'; end if;
    return v_run_id;
  end if;
  insert into public.memory_import_plan_items(
    user_id, import_run_id, ordinal, legacy_external_id, content_hash,
    deterministic_memory_id, retrieval_tier, authority_tier, reason_codes
  )
  select 'user', v_run_id, ordinal, legacy_external_id, content_hash,
    deterministic_memory_id, retrieval_tier, authority_tier, reason_codes
  from jsonb_to_recordset(p_plan) x(
    ordinal int, legacy_external_id text, content_hash text,
    deterministic_memory_id uuid, retrieval_tier text,
    authority_tier text, reason_codes text[]
  );
  insert into public.memory_operations(
    user_id, import_run_id, operation_type, idempotency_key, actor_type, policy_version
  ) values ('user', v_run_id, 'legacy_delta_run_create', p_idempotency_key, 'migration', v_policy)
  returning id into v_operation_id;
  perform public.xiaoc_memory_finish_operation(
    'user', v_operation_id, 'success', null, '{}'::uuid[], null,
    jsonb_build_object('expected_record_count', 16, 'classification_digest', v_class_digest)
  );
  return v_run_id;
end;
$$;

create or replace function public.xiaoc_memory_finalize_delta_import_run(
  p_import_run_id uuid,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_op uuid;
  v_count integer;
  v_ids uuid[];
  v_policy constant text := 'xiaoc-historical-delta-v1';
  v_class_digest constant text := '84db2db26c74441dcbe20d4df486b3bb30771f34c6b95a3b79b2221a96b386ba';
begin
  perform 1 from public.memory_import_runs
  where user_id = 'user' and id = p_import_run_id and run_status = 'applying'
    and policy_version = v_policy and classification_digest = v_class_digest
    and expected_record_count = 16 for update;
  if not found then raise exception 'same-user applying delta run required'; end if;
  select count(*), array_agg(m.memory_id order by m.memory_id) into v_count, v_ids
  from public.legacy_memory_map m
  join public.memory_import_plan_items p
    on p.user_id = m.user_id and p.import_run_id = m.import_run_id
    and p.legacy_external_id = m.legacy_external_id
    and p.content_hash = m.original_content_hash
    and p.deterministic_memory_id = m.memory_id
    and p.retrieval_tier = m.initial_retrieval_tier
  join public.memory_items i
    on i.user_id = m.user_id and i.id = m.memory_id
    and i.content_hash = m.original_content_hash
    and i.origin_system = 'ombre_legacy' and i.memory_class = 'observation'
    and i.provenance_status = 'legacy_unverified' and i.lifecycle_status = 'active'
    and i.retrieval_tier = 'shadow_only' and i.authority_tier = 'none'
  where m.user_id = 'user' and m.import_run_id = p_import_run_id;
  if v_count <> 16
    or (select count(*) from public.legacy_memory_map where user_id = 'user' and import_run_id = p_import_run_id) <> 16
    or (select count(*) from public.memory_import_plan_items where user_id = 'user' and import_run_id = p_import_run_id) <> 16
    or exists(select 1 from public.memory_provenance where user_id = 'user' and memory_id = any(v_ids))
    or exists(select 1 from public.memory_pins where user_id = 'user' and memory_id = any(v_ids))
    or exists(select 1 from public.memory_embeddings where user_id = 'user' and memory_id = any(v_ids))
    or (select count(*) from public.memory_operations where user_id = 'user'
      and import_run_id = p_import_run_id and operation_type = 'legacy_import'
      and result_status = 'success') <> 16 then
    raise exception 'M2D delta final validation failed';
  end if;
  update public.memory_import_runs set
    run_status = 'complete', completed_at = now(), imported_count = 16,
    rejected_count = 0,
    tier_statistics = jsonb_build_object('active_legacy', 0, 'low_authority', 0, 'shadow_only', 16, 'disabled', 0),
    validation_summary = jsonb_build_object('result', 'PASS', 'validated_count', 16)
  where user_id = 'user' and id = p_import_run_id and run_status = 'applying';
  insert into public.memory_operations(
    user_id, import_run_id, operation_type, idempotency_key, actor_type, policy_version
  ) values ('user', p_import_run_id, 'legacy_delta_finalize', p_idempotency_key, 'migration', v_policy)
  returning id into v_op;
  perform public.xiaoc_memory_finish_operation(
    'user', v_op, 'success', null, v_ids, null,
    jsonb_build_object('tiers', jsonb_build_object('shadow_only', 16))
  );
  return v_op;
end;
$$;

create or replace function public.xiaoc_memory_rollback_delta_import_run(
  p_import_run_id uuid,
  p_contract_digest text,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_op uuid;
  v_ids uuid[];
  v_status text;
  v_policy text;
begin
  select run_status, policy_version into v_status, v_policy
  from public.memory_import_runs
  where user_id = 'user' and id = p_import_run_id
    and policy_version = 'xiaoc-historical-delta-v1'
    and expected_record_count = 16 and classification_digest = p_contract_digest
  for update;
  if not found or v_status not in ('complete', 'failed', 'disabled') then
    raise exception 'same-user rollback-eligible delta run and contract required';
  end if;
  select id into v_op from public.memory_operations
  where user_id = 'user' and import_run_id = p_import_run_id
    and operation_type = 'legacy_delta_rollback'
    and idempotency_key = p_idempotency_key and result_status = 'success';
  if v_op is not null then return v_op; end if;
  if v_status = 'disabled' then raise exception 'disabled delta run requires its original rollback idempotency key'; end if;
  select array_agg(memory_id order by memory_id) into v_ids
  from public.legacy_memory_map where user_id = 'user' and import_run_id = p_import_run_id;
  if cardinality(v_ids) <> 16
    or exists(select 1 from public.memory_items where user_id = 'user' and id = any(v_ids)
      and (origin_system <> 'ombre_legacy' or provenance_status <> 'legacy_unverified'))
    or exists(select 1 from public.memory_provenance where user_id = 'user' and memory_id = any(v_ids))
    or exists(select 1 from public.memory_pins where user_id = 'user' and memory_id = any(v_ids))
    or exists(select 1 from public.memory_embeddings where user_id = 'user' and memory_id = any(v_ids))
    or exists(select 1 from public.memory_relations where user_id = 'user'
      and (from_memory_id = any(v_ids) or to_memory_id = any(v_ids))) then
    raise exception 'delta rollback blocked by target mismatch or downstream dependency';
  end if;
  insert into public.memory_operations(
    user_id, import_run_id, operation_type, idempotency_key, actor_type, policy_version
  ) values ('user', p_import_run_id, 'legacy_delta_rollback', p_idempotency_key, 'migration', v_policy)
  returning id into v_op;
  update public.memory_items set retrieval_tier = 'disabled', authority_tier = 'none',
    revision = revision + 1, updated_at = now()
  where user_id = 'user' and id = any(v_ids)
    and (retrieval_tier <> 'disabled' or authority_tier <> 'none');
  update public.memory_import_runs set run_status = 'disabled',
    validation_summary = validation_summary || jsonb_build_object('rollback', 'PASS')
  where user_id = 'user' and id = p_import_run_id and run_status = v_status;
  perform public.xiaoc_memory_finish_operation(
    'user', v_op, 'success', null, v_ids, null,
    jsonb_build_object('disabled_count', 16)
  );
  return v_op;
end;
$$;

create or replace function public.xiaoc_memory_reconcile_legacy_delta_exclusions(
  p_source_snapshot_sha256 text,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_op uuid;
  v_result jsonb;
  v_archive_ids constant uuid[] := array[
    '9de75e20-ed23-5749-84be-5c989bd00759'::uuid,
    'b1bfec24-f33e-5b99-9a35-a990066d146f'::uuid,
    '32823b43-175d-54b1-9b06-d280e6d3a08a'::uuid
  ];
  v_missing_ids constant uuid[] := array[
    'a0318f08-dc09-5d4a-9c4c-f4f6473489f3'::uuid,
    '247db878-608d-5a61-8685-1a40889f45c8'::uuid
  ];
begin
  if p_source_snapshot_sha256 <> 'a6cc6820c7396af0eb8adc2c3b1c0a8596332beb946fbaf4bf93a86038d81e5d'
    or nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'locked delta reconciliation contract required';
  end if;
  select after_state into v_result from public.memory_operations
  where user_id = 'user' and operation_type = 'legacy_delta_reconcile_exclusions'
    and idempotency_key = p_idempotency_key and result_status = 'success';
  if v_result is not null then return v_result; end if;
  if (select count(*) from public.memory_items where user_id = 'user'
      and id = any(v_archive_ids || v_missing_ids)
      and origin_system = 'ombre_legacy' and provenance_status = 'legacy_unverified') <> 5
    or exists (
      select 1 from public.memory_items i
      where i.user_id = 'user' and i.id = any(v_archive_ids || v_missing_ids)
        and (i.id, i.content_hash) not in (
          values
          ('9de75e20-ed23-5749-84be-5c989bd00759'::uuid, '86cb481dc6f720d1e4ab2eff841f62904567d31812a7f8b860ddcd7f378f2ecb'),
          ('b1bfec24-f33e-5b99-9a35-a990066d146f'::uuid, '42f788fb699192ed24742e858b84ac3b2394a419b37f5c1f5dd410bfbc7e2ec3'),
          ('32823b43-175d-54b1-9b06-d280e6d3a08a'::uuid, '7a741b297d7d97edd470def29a879477199ebcd63ade98c09a106f24c815a0c2'),
          ('a0318f08-dc09-5d4a-9c4c-f4f6473489f3'::uuid, 'd2cfddd3bf4d437444220b44f9991c5b53dcc9498d6bb537e625d4663c46da88'),
          ('247db878-608d-5a61-8685-1a40889f45c8'::uuid, '4b88854ce96d0f4034bbfd18314eabfdd446a45d307ed86c2975735d4c90ffbb')
        )
    ) then raise exception 'legacy exclusion target mismatch'; end if;
  insert into public.memory_operations(
    user_id, operation_type, idempotency_key, actor_type, policy_version
  ) values ('user', 'legacy_delta_reconcile_exclusions', p_idempotency_key, 'migration', 'xiaoc-historical-delta-v1')
  returning id into v_op;
  update public.memory_items set lifecycle_status = 'archived', archived_at = coalesce(archived_at, now()),
    retrieval_tier = 'disabled', authority_tier = 'none', revision = revision + 1, updated_at = now()
  where user_id = 'user' and id = any(v_archive_ids) and lifecycle_status <> 'archived';
  update public.memory_items set retrieval_tier = 'disabled', authority_tier = 'none',
    revision = revision + 1, updated_at = now()
  where user_id = 'user' and id = any(v_missing_ids)
    and (retrieval_tier <> 'disabled' or authority_tier <> 'none');
  v_result := jsonb_build_object(
    'archived_count', (select count(*) from public.memory_items where user_id = 'user' and id = any(v_archive_ids) and lifecycle_status = 'archived'),
    'missing_disabled_count', (select count(*) from public.memory_items where user_id = 'user' and id = any(v_missing_ids) and retrieval_tier = 'disabled' and authority_tier = 'none')
  );
  perform public.xiaoc_memory_finish_operation(
    'user', v_op, 'success', null, v_archive_ids || v_missing_ids, null, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.xiaoc_memory_create_delta_import_run(jsonb, text) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_finalize_delta_import_run(uuid, text) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_rollback_delta_import_run(uuid, text, text) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_reconcile_legacy_delta_exclusions(text, text) from public, anon, authenticated;
grant execute on function public.xiaoc_memory_create_delta_import_run(jsonb, text) to service_role;
grant execute on function public.xiaoc_memory_finalize_delta_import_run(uuid, text) to service_role;
grant execute on function public.xiaoc_memory_rollback_delta_import_run(uuid, text, text) to service_role;
grant execute on function public.xiaoc_memory_reconcile_legacy_delta_exclusions(text, text) to service_role;

comment on function public.xiaoc_memory_create_delta_import_run(jsonb, text)
  is 'Creates only the exact approved 2026-09-21 Ombre delta import run.';
comment on function public.xiaoc_memory_reconcile_legacy_delta_exclusions(text, text)
  is 'Archives three full-volume-confirmed legacy transitions and disables two absent/ambiguous legacy items without declaring them deleted.';

-- XiaoC Memory Engine M2B transactional validation.
-- Run once as one complete script in the target Supabase SQL Editor.
-- All test writes are isolated by fixed test users and rolled back at the end.

begin;

-- Preconditions read row counts only. No Memory content is selected.
do $$
declare
  v_table text;
  v_count bigint;
  v_tables constant text[] := array[
    'memory_items', 'memory_provenance', 'memory_relations', 'memory_embeddings',
    'memory_pins', 'memory_operations', 'memory_import_runs', 'legacy_memory_map'
  ];
begin
  foreach v_table in array v_tables loop
    execute format('select count(*) from public.%I', v_table) into v_count;
    if v_count <> 0 then
      raise exception 'ASSERTION FAILED: pre-existing rows found in public.%', v_table;
    end if;
  end loop;
end;
$$;

-- 1. A verified memory without valid provenance must fail deferred integrity.
do $$
declare
  v_rejected boolean := false;
begin
  begin
    insert into public.memory_items (
      id, user_id, canonical_content, content_hash, origin_system,
      memory_class, category, provenance_status, lifecycle_status,
      retrieval_tier, authority_tier, authority_policy_version,
      capture_policy_version
    ) values (
      '10000000-0000-4000-8000-000000000001'::uuid,
      '__xiaoc_m2b_validation_missing_provenance__',
      'M2B validation fixture without provenance',
      encode(extensions.digest(convert_to('M2B validation fixture without provenance', 'UTF8'), 'sha256'), 'hex'),
      'xiaoc_native', 'observation', 'm2b_validation', 'verified_user',
      'active', null, 'native_verified', 'm2b-validation-authority-v1',
      'm2b-validation-capture-v1'
    );
    set constraints memory_items_verified_integrity immediate;
  exception when others then
    if position('requires valid message provenance' in sqlerrm) = 0 then
      raise;
    end if;
    v_rejected := true;
  end;
  set constraints memory_items_verified_integrity deferred;
  if not v_rejected then
    raise exception 'ASSERTION FAILED: verified memory without provenance was accepted';
  end if;
end;
$$;

-- 2. The protected confirmation RPC creates a verified native Memory with
-- valid provenance. The message-backed verified_user RPC is intentionally not
-- invoked because this validation must not insert into the existing messages table.
do $$
declare
  v_first uuid;
  v_second uuid;
  v_operation_id uuid;
  v_duplicate_rejected boolean := false;
begin
  v_first := public.xiaoc_memory_confirm_manual(
    '__xiaoc_m2b_validation_a__',
    'M2B manual evidence fixture A',
    'M2B canonical fixture A',
    'observation',
    'm2b_validation',
    'm2b-validation:claim:a',
    'm2b-validation-capture-v1',
    'm2b-validation-authority-v1',
    'm2b-validation-manual-a'
  );
  v_second := public.xiaoc_memory_confirm_manual(
    '__xiaoc_m2b_validation_a__',
    'M2B manual evidence fixture A',
    'M2B canonical fixture A',
    'observation',
    'm2b_validation',
    'm2b-validation:claim:a',
    'm2b-validation-capture-v1',
    'm2b-validation-authority-v1',
    'm2b-validation-manual-a'
  );
  if v_first is null or v_first <> v_second then
    raise exception 'ASSERTION FAILED: manual confirmation RPC is not idempotent';
  end if;
  if (select count(*) from public.memory_items
      where user_id = '__xiaoc_m2b_validation_a__' and id = v_first) <> 1 then
    raise exception 'ASSERTION FAILED: valid protected verified memory was not created exactly once';
  end if;
  if (select count(*) from public.memory_provenance
      where user_id = '__xiaoc_m2b_validation_a__' and memory_id = v_first
        and source_kind = 'manual_user') <> 1 then
    raise exception 'ASSERTION FAILED: valid manual provenance was not created exactly once';
  end if;
  select source_operation_id into v_operation_id
  from public.memory_provenance
  where user_id = '__xiaoc_m2b_validation_a__' and memory_id = v_first;

  begin
    insert into public.memory_provenance (
      user_id, memory_id, source_kind, source_locator_key,
      source_operation_id, source_role, evidence_text, evidence_hash,
      evidence_type, observed_at
    ) values (
      '__xiaoc_m2b_validation_a__', v_first, 'manual_user',
      'manual:' || v_operation_id::text, v_operation_id, 'user',
      'M2B manual evidence fixture A',
      encode(extensions.digest(convert_to('M2B manual evidence fixture A', 'UTF8'), 'sha256'), 'hex'),
      'confirmation', now()
    );
  exception when unique_violation then
    v_duplicate_rejected := true;
  end;
  if not v_duplicate_rejected then
    raise exception 'ASSERTION FAILED: duplicate manual provenance was accepted';
  end if;
end;
$$;

-- Create additional protected test memories for isolation and relation checks.
do $$
declare
  v_b uuid;
  v_c uuid;
  v_other_user uuid;
begin
  v_b := public.xiaoc_memory_confirm_manual(
    '__xiaoc_m2b_validation_a__', 'M2B manual evidence fixture B',
    'M2B canonical fixture B', 'observation', 'm2b_validation',
    'm2b-validation:claim:b', 'm2b-validation-capture-v1',
    'm2b-validation-authority-v1', 'm2b-validation-manual-b'
  );
  v_c := public.xiaoc_memory_confirm_manual(
    '__xiaoc_m2b_validation_a__', 'M2B manual evidence fixture C',
    'M2B canonical fixture C', 'observation', 'm2b_validation',
    'm2b-validation:claim:c', 'm2b-validation-capture-v1',
    'm2b-validation-authority-v1', 'm2b-validation-manual-c'
  );
  v_other_user := public.xiaoc_memory_confirm_manual(
    '__xiaoc_m2b_validation_b__', 'M2B manual evidence fixture other user',
    'M2B canonical fixture other user', 'observation', 'm2b_validation',
    'm2b-validation:claim:other', 'm2b-validation-capture-v1',
    'm2b-validation-authority-v1', 'm2b-validation-manual-other'
  );
  if v_b is null or v_c is null or v_other_user is null then
    raise exception 'ASSERTION FAILED: protected fixture creation returned NULL';
  end if;
end;
$$;

-- 3. Composite same-user FKs reject cross-user provenance/relation/embedding/PIN.
do $$
declare
  v_a uuid := (select (affected_memory_ids)[1] from public.memory_operations
    where user_id = '__xiaoc_m2b_validation_a__' and operation_type = 'manual_confirm'
      and idempotency_key = 'm2b-validation-manual-a' and result_status = 'success');
  v_other uuid := (select (affected_memory_ids)[1] from public.memory_operations
    where user_id = '__xiaoc_m2b_validation_b__' and operation_type = 'manual_confirm'
      and idempotency_key = 'm2b-validation-manual-other' and result_status = 'success');
  v_operation uuid := (select source_operation_id from public.memory_provenance
    where user_id = '__xiaoc_m2b_validation_a__'
      and memory_id = v_a);
  v_failed boolean;
begin
  v_failed := false;
  begin
    insert into public.memory_provenance (
      user_id, memory_id, source_kind, source_locator_key, source_operation_id,
      source_role, evidence_text, evidence_hash, evidence_type, observed_at
    ) values (
      '__xiaoc_m2b_validation_a__', v_other, 'manual_user',
      'manual:' || v_operation::text, v_operation, 'user',
      'cross-user provenance fixture',
      encode(extensions.digest(convert_to('cross-user provenance fixture', 'UTF8'), 'sha256'), 'hex'),
      'confirmation', now()
    );
  exception when foreign_key_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'ASSERTION FAILED: cross-user provenance was accepted'; end if;

  v_failed := false;
  begin
    insert into public.memory_relations (
      user_id, from_memory_id, to_memory_id, relation_type, operation_id
    ) values (
      '__xiaoc_m2b_validation_a__',
      v_a,
      v_other, 'contradicts', v_operation
    );
  exception when foreign_key_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'ASSERTION FAILED: cross-user relation was accepted'; end if;

  v_failed := false;
  begin
    insert into public.memory_embeddings (
      user_id, memory_id, provider, model, embedding_version,
      preprocessor_version, dimensions, content_hash, embedding, rollout_status
    ) values (
      '__xiaoc_m2b_validation_a__', v_other, 'm2b-test', 'm2b-test',
      'm2b-cross-user', 'm2b-test', 3,
      repeat('0', 64), '[0.1,0.2,0.3]'::extensions.vector, 'shadow'
    );
  exception when foreign_key_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'ASSERTION FAILED: cross-user embedding was accepted'; end if;

  v_failed := false;
  begin
    insert into public.memory_pins (
      user_id, memory_id, scope, ordinal, pin_status, pinned_by,
      operation_id, pinned_at
    ) values (
      '__xiaoc_m2b_validation_a__', v_other, 'core', 9001,
      'active', 'user', v_operation, now()
    );
  exception when foreign_key_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'ASSERTION FAILED: cross-user PIN was accepted'; end if;
end;
$$;

-- 4. Relation application is atomic and a reverse supersedes cycle is rejected.
do $$
declare
  v_a uuid := (select (affected_memory_ids)[1] from public.memory_operations
    where user_id = '__xiaoc_m2b_validation_a__' and operation_type = 'manual_confirm'
      and idempotency_key = 'm2b-validation-manual-a' and result_status = 'success');
  v_b uuid := (select (affected_memory_ids)[1] from public.memory_operations
    where user_id = '__xiaoc_m2b_validation_a__' and operation_type = 'manual_confirm'
      and idempotency_key = 'm2b-validation-manual-b' and result_status = 'success');
  v_operation uuid;
  v_cycle_rejected boolean := false;
begin
  v_operation := public.xiaoc_memory_apply_relation(
    '__xiaoc_m2b_validation_a__', v_a, v_b, 'supersedes', 1, 1,
    'm2b-validation-relation-v1', 'm2b-validation-supersedes-a-b'
  );
  if not exists (select 1 from public.memory_relations where user_id = '__xiaoc_m2b_validation_a__'
    and from_memory_id = v_a and to_memory_id = v_b and relation_type = 'supersedes'
    and operation_id = v_operation) then
    raise exception 'ASSERTION FAILED: supersedes relation missing';
  end if;
  if not exists (select 1 from public.memory_items where user_id = '__xiaoc_m2b_validation_a__'
    and id = v_b and lifecycle_status = 'superseded' and revision = 2) then
    raise exception 'ASSERTION FAILED: superseded lifecycle/revision not updated atomically';
  end if;
  if not exists (select 1 from public.memory_operations where user_id = '__xiaoc_m2b_validation_a__'
    and id = v_operation and result_status = 'success'
    and array[v_a, v_b] <@ affected_memory_ids) then
    raise exception 'ASSERTION FAILED: relation operation ledger not completed atomically';
  end if;
  begin
    perform public.xiaoc_memory_apply_relation(
      '__xiaoc_m2b_validation_a__', v_b, v_a, 'supersedes', 2, 1,
      'm2b-validation-relation-v1', 'm2b-validation-supersedes-b-a-cycle'
    );
  exception when others then
    if position('supersedes cycle rejected' in sqlerrm) = 0 then raise; end if;
    v_cycle_rejected := true;
  end;
  if not v_cycle_rejected then
    raise exception 'ASSERTION FAILED: supersedes cycle was accepted';
  end if;
  if exists (select 1 from public.memory_relations where user_id = '__xiaoc_m2b_validation_a__'
    and from_memory_id = v_b and to_memory_id = v_a and relation_type = 'supersedes') then
    raise exception 'ASSERTION FAILED: rejected cycle left a relation row';
  end if;
end;
$$;

-- 5. Deterministic legacy import is idempotent and hash conflicts fail closed.
do $$
declare
  v_run uuid;
  v_first uuid;
  v_second uuid;
  v_conflict_rejected boolean := false;
  v_content constant text := 'M2B entirely fictional legacy fixture';
  v_hash text := encode(extensions.digest(convert_to(v_content, 'UTF8'), 'sha256'), 'hex');
  v_other_content constant text := 'M2B different fictional legacy fixture';
  v_other_hash text := encode(extensions.digest(convert_to(v_other_content, 'UTF8'), 'sha256'), 'hex');
begin
  v_run := public.xiaoc_memory_create_import_run(
    '__xiaoc_m2b_validation_legacy__', 'm2b_validation_fixture', repeat('a', 64),
    'm2b-validation-importer-v1', 'm2b-validation-legacy-policy-v1', 1, 1
  );
  v_first := public.xiaoc_memory_import_legacy(
    '__xiaoc_m2b_validation_legacy__', v_run, 'm2b_validation_fixture',
    'fictional-bucket-0001', 'fixtures/fictional-bucket-0001.json',
    v_content, v_hash, '{}'::jsonb, '{}'::jsonb, false, null,
    '2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z', 0,
    'm2b-validation-legacy-policy-v1', 'shadow_only', null,
    'm2b_validation', 'observation', 'm2b-validation-authority-v1',
    'm2b-validation-capture-v1'
  );
  v_second := public.xiaoc_memory_import_legacy(
    '__xiaoc_m2b_validation_legacy__', v_run, 'm2b_validation_fixture',
    'fictional-bucket-0001', 'fixtures/fictional-bucket-0001.json',
    v_content, v_hash, '{}'::jsonb, '{}'::jsonb, false, null,
    '2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z', 0,
    'm2b-validation-legacy-policy-v1', 'shadow_only', null,
    'm2b_validation', 'observation', 'm2b-validation-authority-v1',
    'm2b-validation-capture-v1'
  );
  if v_first <> v_second then
    raise exception 'ASSERTION FAILED: same legacy identity/hash returned different memory IDs';
  end if;
  if (select count(*) from public.memory_items where user_id = '__xiaoc_m2b_validation_legacy__') <> 1
     or (select count(*) from public.legacy_memory_map where user_id = '__xiaoc_m2b_validation_legacy__') <> 1 then
    raise exception 'ASSERTION FAILED: idempotent legacy import created duplicate rows';
  end if;
  begin
    perform public.xiaoc_memory_import_legacy(
      '__xiaoc_m2b_validation_legacy__', v_run, 'm2b_validation_fixture',
      'fictional-bucket-0001', 'fixtures/fictional-bucket-0001.json',
      v_other_content, v_other_hash, '{}'::jsonb, '{}'::jsonb, false, null,
      '2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z', 0,
      'm2b-validation-legacy-policy-v1', 'shadow_only', null,
      'm2b_validation', 'observation', 'm2b-validation-authority-v1',
      'm2b-validation-capture-v1'
    );
  exception when others then
    if position('content hash conflict' in sqlerrm) = 0 then raise; end if;
    v_conflict_rejected := true;
  end;
  if not v_conflict_rejected then
    raise exception 'ASSERTION FAILED: changed legacy content silently overwrote canonical memory';
  end if;
  if (select count(*) from public.memory_items where user_id = '__xiaoc_m2b_validation_legacy__') <> 1 then
    raise exception 'ASSERTION FAILED: conflicting legacy import created a second canonical memory';
  end if;
end;
$$;

-- 6. Test vectors only: shadow registration, one-active uniqueness, and atomic activation.
do $$
declare
  v_memory uuid := (select (affected_memory_ids)[1] from public.memory_operations
    where user_id = '__xiaoc_m2b_validation_a__' and operation_type = 'manual_confirm'
      and idempotency_key = 'm2b-validation-manual-c' and result_status = 'success');
  v_hash text := (select content_hash from public.memory_items
    where user_id = '__xiaoc_m2b_validation_a__' and id = v_memory);
  v_v1 uuid;
  v_v2 uuid;
  v_unique_rejected boolean := false;
begin
  v_v1 := public.xiaoc_memory_register_embedding(
    '__xiaoc_m2b_validation_a__', v_memory, 'm2b-test-provider', 'm2b-test-model',
    'm2b-test-v1', 'm2b-test-preprocessor-v1', v_hash,
    '[0.1,0.2,0.3]'::extensions.vector,
    'm2b-validation-embedding-v1', 'm2b-validation-register-v1'
  );
  if not exists (select 1 from public.memory_embeddings where id = v_v1
    and user_id = '__xiaoc_m2b_validation_a__' and rollout_status = 'shadow' and dimensions = 3) then
    raise exception 'ASSERTION FAILED: shadow embedding registration failed';
  end if;
  perform public.xiaoc_memory_activate_embedding(
    '__xiaoc_m2b_validation_a__', v_v1,
    'm2b-validation-embedding-v1', 'm2b-validation-activate-v1'
  );
  v_v2 := public.xiaoc_memory_register_embedding(
    '__xiaoc_m2b_validation_a__', v_memory, 'm2b-test-provider', 'm2b-test-model',
    'm2b-test-v2', 'm2b-test-preprocessor-v1', v_hash,
    '[0.3,0.2,0.1]'::extensions.vector,
    'm2b-validation-embedding-v1', 'm2b-validation-register-v2'
  );
  begin
    update public.memory_embeddings set rollout_status = 'active'
    where user_id = '__xiaoc_m2b_validation_a__' and id = v_v2;
  exception when unique_violation then v_unique_rejected := true;
  end;
  if not v_unique_rejected then
    raise exception 'ASSERTION FAILED: two active embeddings were accepted';
  end if;
  perform public.xiaoc_memory_activate_embedding(
    '__xiaoc_m2b_validation_a__', v_v2,
    'm2b-validation-embedding-v1', 'm2b-validation-activate-v2'
  );
  if (select count(*) from public.memory_embeddings where user_id = '__xiaoc_m2b_validation_a__'
      and memory_id = v_memory and rollout_status = 'active') <> 1 then
    raise exception 'ASSERTION FAILED: active embedding uniqueness not preserved after activation';
  end if;
  if not exists (select 1 from public.memory_embeddings where id = v_v1 and rollout_status = 'retired')
     or not exists (select 1 from public.memory_embeddings where id = v_v2 and rollout_status = 'active') then
    raise exception 'ASSERTION FAILED: embedding activation did not retire old and activate new atomically';
  end if;
  if exists (select 1 from public.memory_embeddings where user_id like '__xiaoc_m2b_validation_%'
    and rollout_status not in ('shadow', 'active', 'retired', 'stale')) then
    raise exception 'ASSERTION FAILED: invalid or fake failed embedding row exists';
  end if;
end;
$$;

-- 7. Single-row operation transition and immutable terminal history.
do $$
declare
  v_old uuid := '70000000-0000-4000-8000-000000000001'::uuid;
  v_compensation uuid := '70000000-0000-4000-8000-000000000002'::uuid;
  v_terminal_rejected boolean := false;
  v_old_created timestamptz;
begin
  insert into public.memory_operations (
    id, user_id, operation_type, idempotency_key, actor_type, policy_version
  ) values (
    v_old, '__xiaoc_m2b_validation_operations__', 'validation_operation',
    'm2b-validation-operation-original', 'system', 'm2b-validation-operation-v1'
  );
  select created_at into v_old_created from public.memory_operations where id = v_old;
  perform public.xiaoc_memory_finish_operation(
    '__xiaoc_m2b_validation_operations__', v_old, 'success', 'validated'
  );
  if not exists (select 1 from public.memory_operations where id = v_old
    and result_status = 'success' and completed_at is not null) then
    raise exception 'ASSERTION FAILED: started operation did not reach terminal success';
  end if;
  begin
    update public.memory_operations set reason_code = 'illegal-second-update' where id = v_old;
  exception when others then
    if position('terminal operation cannot be changed' in sqlerrm) = 0 then raise; end if;
    v_terminal_rejected := true;
  end;
  if not v_terminal_rejected then
    raise exception 'ASSERTION FAILED: terminal operation was mutable';
  end if;
  insert into public.memory_operations (
    id, user_id, operation_type, idempotency_key, actor_type, policy_version,
    compensates_operation_id
  ) values (
    v_compensation, '__xiaoc_m2b_validation_operations__', 'validation_compensation',
    'm2b-validation-operation-compensation', 'system', 'm2b-validation-operation-v1', v_old
  );
  perform public.xiaoc_memory_finish_operation(
    '__xiaoc_m2b_validation_operations__', v_compensation, 'success', 'compensation-validated'
  );
  if not exists (select 1 from public.memory_operations where id = v_compensation
    and compensates_operation_id = v_old and result_status = 'success') then
    raise exception 'ASSERTION FAILED: compensation operation was not independently recorded';
  end if;
  if not exists (select 1 from public.memory_operations where id = v_old
    and result_status = 'success' and created_at = v_old_created and reason_code = 'validated') then
    raise exception 'ASSERTION FAILED: compensation modified the original terminal operation';
  end if;
end;
$$;

-- 8-9. Catalog-level ACL and RLS validation. SQL Editor admin bypass is not treated as an ACL failure.
do $$
declare
  v_table text;
  v_rpc_count integer;
  v_tables constant text[] := array[
    'memory_items', 'memory_provenance', 'memory_relations', 'memory_embeddings',
    'memory_pins', 'memory_operations', 'memory_import_runs', 'legacy_memory_map'
  ];
begin
  foreach v_table in array v_tables loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table and c.relkind = 'r'
        and c.relrowsecurity
    ) then
      raise exception 'ASSERTION FAILED: RLS is not enabled on %', v_table;
    end if;
    if has_table_privilege('anon', 'public.' || v_table, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || v_table, 'INSERT')
       or has_table_privilege('service_role', 'public.' || v_table, 'INSERT')
       or has_table_privilege('service_role', 'public.' || v_table, 'UPDATE')
       or has_table_privilege('service_role', 'public.' || v_table, 'DELETE') then
      raise exception 'ASSERTION FAILED: protected direct mutation grant exists on %', v_table;
    end if;
    if not has_table_privilege('service_role', 'public.' || v_table, 'SELECT') then
      raise exception 'ASSERTION FAILED: service_role lacks intended read grant on %', v_table;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_table) then
      raise exception 'ASSERTION FAILED: unexpected direct-access RLS policy exists on %', v_table;
    end if;
  end loop;

  select count(*) into v_rpc_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = any (array[
      'xiaoc_memory_capture_verified', 'xiaoc_memory_confirm_manual',
      'xiaoc_memory_apply_relation', 'xiaoc_memory_consolidate',
      'xiaoc_memory_import_legacy', 'xiaoc_memory_register_embedding',
      'xiaoc_memory_activate_embedding', 'xiaoc_memory_set_pin',
      'xiaoc_memory_finish_operation', 'xiaoc_memory_create_import_run'
    ])
    and has_function_privilege('service_role', p.oid, 'EXECUTE')
    and not has_function_privilege('anon', p.oid, 'EXECUTE')
    and not has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_rpc_count <> 10 then
    raise exception 'ASSERTION FAILED: protected RPC execute grants do not match the 10-function boundary';
  end if;
end;
$$;

-- Final namespace-only assertions before the unconditional rollback.
do $$
begin
  if exists (select 1 from public.memory_items where user_id not like '__xiaoc_m2b_validation_%') then
    raise exception 'ASSERTION FAILED: new Memory Engine tables contain non-test business data';
  end if;
  if exists (select 1 from public.memory_embeddings where user_id not like '__xiaoc_m2b_validation_%') then
    raise exception 'ASSERTION FAILED: new embedding table contains non-test business data';
  end if;
end;
$$;

select 'XIAOC_MEMORY_ENGINE_M2B_VALIDATION_PASS' as validation_result;

rollback;

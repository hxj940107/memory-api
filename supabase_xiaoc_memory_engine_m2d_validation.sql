-- XiaoC Memory Engine M2D post-migration validation.
-- Run the whole file in one Supabase SQL Editor execution.
-- All rows are fictitious and the final statement is ROLLBACK. There is no COMMIT.

begin;

-- 1. Schema objects, columns, constraints, indexes and protected RPCs.
do $validation$
declare
  v_missing text[];
begin
  select array_agg(required_name order by required_name) into v_missing
  from (values
    ('table:memory_import_plan_items', to_regclass('public.memory_import_plan_items') is not null),
    ('column:memory_import_runs.manifest_sha256', exists(select 1 from information_schema.columns where table_schema='public' and table_name='memory_import_runs' and column_name='manifest_sha256')),
    ('column:memory_import_runs.execution_order_digest', exists(select 1 from information_schema.columns where table_schema='public' and table_name='memory_import_runs' and column_name='execution_order_digest')),
    ('column:memory_import_runs.classification_digest', exists(select 1 from information_schema.columns where table_schema='public' and table_name='memory_import_runs' and column_name='classification_digest')),
    ('column:memory_import_runs.expected_record_count', exists(select 1 from information_schema.columns where table_schema='public' and table_name='memory_import_runs' and column_name='expected_record_count')),
    ('column:memory_import_runs.policy_version', exists(select 1 from information_schema.columns where table_schema='public' and table_name='memory_import_runs' and column_name='policy_version')),
    ('column:memory_operations.import_run_id', exists(select 1 from information_schema.columns where table_schema='public' and table_name='memory_operations' and column_name='import_run_id')),
    ('index:memory_operations_import_run_idx', to_regclass('public.memory_operations_import_run_idx') is not null),
    ('rpc:create_import_run', to_regprocedure('public.xiaoc_memory_create_import_run(text,text,text,text,text,text,integer,text,text,jsonb,text)') is not null),
    ('rpc:start_import_run', to_regprocedure('public.xiaoc_memory_start_import_run(text,uuid,text,text)') is not null),
    ('rpc:fail_import_run', to_regprocedure('public.xiaoc_memory_fail_import_run(text,uuid,text,text,text)') is not null),
    ('rpc:import_legacy', to_regprocedure('public.xiaoc_memory_import_legacy(text,uuid,text,text,text,text,text,jsonb,jsonb,boolean,text,timestamptz,timestamptz,integer,text,text,text,text,text,text,text)') is not null),
    ('rpc:finalize_import_run', to_regprocedure('public.xiaoc_memory_finalize_import_run(text,uuid,text,text)') is not null),
    ('rpc:rollback_import_run', to_regprocedure('public.xiaoc_memory_rollback_import_run(text,uuid,text,text)') is not null)
  ) required(required_name, present)
  where not present;
  if v_missing is not null then
    raise exception 'M2D_VALIDATION_FAILED: missing schema objects: %', v_missing;
  end if;

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public' and t.relname='memory_operations'
      and c.contype='f' and pg_get_constraintdef(c.oid) like 'FOREIGN KEY (user_id, import_run_id)%memory_import_runs%'
  ) then raise exception 'M2D_VALIDATION_FAILED: operation run same-user FK missing'; end if;

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public' and t.relname='memory_import_plan_items'
      and c.contype='f' and pg_get_constraintdef(c.oid) like 'FOREIGN KEY (user_id, import_run_id)%memory_import_runs%'
  ) then raise exception 'M2D_VALIDATION_FAILED: plan run same-user FK missing'; end if;
end
$validation$;

-- Use fixed, unmistakably synthetic owners. Abort if a prior non-transactional test left residue.
do $validation$
begin
  if exists(select 1 from public.memory_import_runs where user_id like '__xiaoc_m2d_validation_%')
    or exists(select 1 from public.memory_items where user_id like '__xiaoc_m2d_validation_%')
    or exists(select 1 from public.memory_operations where user_id like '__xiaoc_m2d_validation_%')
    or exists(select 1 from public.legacy_memory_map where user_id like '__xiaoc_m2d_validation_%')
    or exists(select 1 from public.memory_import_plan_items where user_id like '__xiaoc_m2d_validation_%') then
    raise exception 'M2D_VALIDATION_FAILED: pre-existing validation residue found; run ROLLBACK and inspect it';
  end if;
end
$validation$;

-- Build the production-sized 0/6/95/49 plan. The six approved IDs/hashes are
-- contract metadata only; their real Memory bodies are never read or printed.
do $validation$
declare v_class text; v_order text; v_plan jsonb; v_run uuid;
begin
  with raw_seed as (
    select * from (values
      ('ffb8ce86aa3b','0458ba7f6948ed79cf9ac8f6d66fe1270c5c49beab3ea6edf9c0e35be3a15244','low_authority',array['LOW_RISK_DYNAMIC_DOMAIN','LEGACY_UNVERIFIED','STRONG_RELEVANCE_REQUIRED']::text[]),
      ('632959ffb312','63409c97c8ce34bdb88f749fcbea405ebd35a928e66ad87d3a138eaad791d7b6','low_authority',array['HISTORICAL_CONTINUITY_REVIEW_APPROVED','EXPLICIT_PAST_FRAMING','NO_HIGH_AUTHORITY_MARKER']::text[]),
      ('8815e2b2c20a','66df447a878f179aaccbac98c90bbdd741a6debfb0ae920973f3d68172417a72','low_authority',array['HISTORICAL_CONTINUITY_REVIEW_APPROVED','HISTORICAL_EVENT_SIGNAL','NO_HIGH_AUTHORITY_MARKER']::text[]),
      ('f4c1457bd8d3','4b88854ce96d0f4034bbfd18314eabfdd446a45d307ed86c2975735d4c90ffbb','low_authority',array['HISTORICAL_CONTINUITY_REVIEW_APPROVED','HISTORICAL_EVENT_SIGNAL','NO_HIGH_AUTHORITY_MARKER']::text[]),
      ('1d16fc964753','54398556b3fa29cb00a29cc1b17dcb3eff72f72a6664b0cf668215255925c1d8','low_authority',array['HISTORICAL_CONTINUITY_REVIEW_APPROVED','EXPLICIT_PAST_FRAMING','NO_HIGH_AUTHORITY_MARKER']::text[]),
      ('b4db8014d06e','4f0bbdc4de42a4631d16dcec1bdecf0c7a4c7024e5eb02a37689267f8ea2cafe','low_authority',array['HISTORICAL_CONTINUITY_REVIEW_APPROVED','HISTORICAL_EVENT_SIGNAL','NO_HIGH_AUTHORITY_MARKER']::text[])
    ) a(legacy_external_id,content_hash,retrieval_tier,reason_codes)
    union all select 'test-shadow-'||lpad(g::text,3,'0'),encode(extensions.digest(convert_to('FICTITIOUS_M2D_VALIDATION_MEMORY_test-shadow-'||lpad(g::text,3,'0'),'UTF8'),'sha256'),'hex'),'shadow_only',array['TEST_FIXTURE']::text[] from generate_series(1,95) g
    union all select 'test-disabled-'||lpad(g::text,3,'0'),encode(extensions.digest(convert_to('FICTITIOUS_M2D_VALIDATION_MEMORY_test-disabled-'||lpad(g::text,3,'0'),'UTF8'),'sha256'),'hex'),'disabled',array['TEST_FIXTURE']::text[] from generate_series(1,49) g
  ), plan_seed as (
    select (row_number() over(order by legacy_external_id collate "C")-1)::int ordinal,legacy_external_id,content_hash,
      extensions.uuid_generate_v5('f1c7e436-ff13-5d2c-8e4a-5de7386b6db7'::uuid,'__xiaoc_m2d_validation_a__'||chr(31)||'ombre'||chr(31)||legacy_external_id) deterministic_memory_id,
      retrieval_tier,case when retrieval_tier='low_authority' then 'legacy_limited' else 'none' end authority_tier,reason_codes
    from raw_seed
  )
  select encode(extensions.digest(convert_to(string_agg(
    legacy_external_id||chr(31)||content_hash||chr(31)||deterministic_memory_id::text||chr(31)||retrieval_tier||chr(31)||authority_tier,
    chr(30) order by legacy_external_id collate "C"),'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to(string_agg(
    ordinal::text||chr(31)||legacy_external_id||chr(31)||content_hash||chr(31)||deterministic_memory_id::text,
    chr(30) order by ordinal),'UTF8'),'sha256'),'hex'),
    jsonb_agg(jsonb_build_object('ordinal',ordinal,'legacy_external_id',legacy_external_id,
      'content_hash',content_hash,'deterministic_memory_id',deterministic_memory_id,
      'retrieval_tier',retrieval_tier,'authority_tier',authority_tier,'reason_codes',reason_codes) order by ordinal)
  into v_class,v_order,v_plan from plan_seed;
  v_run:=public.xiaoc_memory_create_import_run('__xiaoc_m2d_validation_a__','ombre',repeat('a',64),repeat('b',64),
    v_order,v_class,150,'m2d-validation-policy-v1','m2d-validation-importer-v1',v_plan,'validation-create-a');
end
$validation$;

-- Approved allowlist was accepted. A swapped-in, non-allowlisted low-authority row must fail.
do $validation$
declare v_plan jsonb; v_class text; v_order text; v_failed boolean:=false;
begin
  with changed as (
    select ordinal,legacy_external_id,content_hash,deterministic_memory_id,
      case when legacy_external_id='ffb8ce86aa3b' then 'shadow_only'
           when legacy_external_id='test-shadow-001' then 'low_authority' else retrieval_tier end retrieval_tier,
      case when legacy_external_id='ffb8ce86aa3b' then 'none'
           when legacy_external_id='test-shadow-001' then 'legacy_limited' else authority_tier end authority_tier,
      case when legacy_external_id='test-shadow-001' then array['TEST_FIXTURE']::text[] else reason_codes end reason_codes
    from public.memory_import_plan_items
    where user_id='__xiaoc_m2d_validation_a__'
      and import_run_id=(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1')
  )
  select encode(extensions.digest(convert_to(string_agg(legacy_external_id||chr(31)||content_hash||chr(31)||deterministic_memory_id::text||chr(31)||retrieval_tier||chr(31)||authority_tier,chr(30) order by legacy_external_id collate "C"),'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to(string_agg(ordinal::text||chr(31)||legacy_external_id||chr(31)||content_hash||chr(31)||deterministic_memory_id::text,chr(30) order by ordinal),'UTF8'),'sha256'),'hex'),
    jsonb_agg(jsonb_build_object('ordinal',ordinal,'legacy_external_id',legacy_external_id,'content_hash',content_hash,
      'deterministic_memory_id',deterministic_memory_id,'retrieval_tier',retrieval_tier,'authority_tier',authority_tier,'reason_codes',reason_codes) order by ordinal)
    into v_class,v_order,v_plan from changed;
  begin
    perform public.xiaoc_memory_create_import_run('__xiaoc_m2d_validation_a__','ombre',repeat('c',64),repeat('d',64),v_order,v_class,150,
      'm2d-validation-policy-bad','m2d-validation-importer-bad',v_plan,'validation-bad-allowlist');
  exception when others then v_failed:=position('low-authority item is not in the locked allowlist' in sqlerrm)>0; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: non-allowlist low_authority was not rejected'; end if;
end
$validation$;

-- Lifecycle, optimistic state and immutable source contract.
select public.xiaoc_memory_start_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'planned','validation-start-a');

do $validation$
declare v_failed boolean;
begin
  v_failed:=false;
  begin perform public.xiaoc_memory_start_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'planned','validation-illegal-reopen');
  exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: illegal lifecycle transition succeeded'; end if;

  begin update public.memory_import_runs set source_archive_sha256=repeat('9',64) where user_id='__xiaoc_m2d_validation_a__';
    raise exception 'M2D_VALIDATION_FAILED: snapshot hash was mutable'; exception when others then
      if sqlerrm like 'M2D_VALIDATION_FAILED:%' then raise; end if; end;
  begin update public.memory_import_runs set manifest_sha256=repeat('9',64) where user_id='__xiaoc_m2d_validation_a__';
    raise exception 'M2D_VALIDATION_FAILED: manifest hash was mutable'; exception when others then
      if sqlerrm like 'M2D_VALIDATION_FAILED:%' then raise; end if; end;
  begin update public.memory_import_runs set classification_digest=repeat('9',64) where user_id='__xiaoc_m2d_validation_a__';
    raise exception 'M2D_VALIDATION_FAILED: classification digest was mutable'; exception when others then
      if sqlerrm like 'M2D_VALIDATION_FAILED:%' then raise; end if; end;
  begin update public.memory_import_runs set execution_order_digest=repeat('9',64) where user_id='__xiaoc_m2d_validation_a__';
    raise exception 'M2D_VALIDATION_FAILED: execution digest was mutable'; exception when others then
      if sqlerrm like 'M2D_VALIDATION_FAILED:%' then raise; end if; end;
  begin update public.memory_import_runs set expected_record_count=149 where user_id='__xiaoc_m2d_validation_a__';
    raise exception 'M2D_VALIDATION_FAILED: expected count was mutable'; exception when others then
      if sqlerrm like 'M2D_VALIDATION_FAILED:%' then raise; end if; end;
  begin update public.memory_import_runs set policy_version='changed' where user_id='__xiaoc_m2d_validation_a__';
    raise exception 'M2D_VALIDATION_FAILED: policy version was mutable'; exception when others then
      if sqlerrm like 'M2D_VALIDATION_FAILED:%' then raise; end if; end;
end
$validation$;

-- Legacy RPC enforcement, plan matching, idempotency and cross-user isolation.
do $validation$
declare r record; v_id1 uuid; v_id2 uuid; v_failed boolean;
begin
  select p.*, 'FICTITIOUS_M2D_VALIDATION_MEMORY_'||p.legacy_external_id fictitious_content into r
    from public.memory_import_plan_items p where p.user_id='__xiaoc_m2d_validation_a__'
      and p.import_run_id=(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1')
      and p.legacy_external_id='test-shadow-001';
  v_failed:=false;
  begin perform public.xiaoc_memory_import_legacy('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'ombre',r.legacy_external_id,
    'validation/stable.txt',r.fictitious_content,r.content_hash,'{}','{}',false,'active',null,null,0,'m2d-validation-policy-v1',r.retrieval_tier,null,'test','stable','m2d-validation-authority','m2d-validation-capture');
  exception when others then v_failed:=position('memory_class must be observation' in sqlerrm)>0; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: stable legacy import was not rejected'; end if;

  v_failed:=false;
  begin perform public.xiaoc_memory_import_legacy('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'ombre',r.legacy_external_id,
    'validation/active.txt',r.fictitious_content,r.content_hash,'{}','{}',false,'active',null,null,0,'m2d-validation-policy-v1','active_legacy',null,'test','observation','m2d-validation-authority','m2d-validation-capture');
  exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: active_legacy was not rejected'; end if;

  v_failed:=false;
  begin perform public.xiaoc_memory_import_legacy('__xiaoc_m2d_validation_b__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'ombre',r.legacy_external_id,
    'validation/cross.txt',r.fictitious_content,r.content_hash,'{}','{}',false,'active',null,null,0,'m2d-validation-policy-v1',r.retrieval_tier,null,'test','observation','m2d-validation-authority','m2d-validation-capture');
  exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: cross-user import succeeded'; end if;

  v_id1:=public.xiaoc_memory_import_legacy('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'ombre',r.legacy_external_id,
    'validation/test-shadow-001.txt',r.fictitious_content,r.content_hash,'{}','{}',false,'active',null,null,0,'m2d-validation-policy-v1',r.retrieval_tier,null,'test','observation','m2d-validation-authority','m2d-validation-capture');
  v_id2:=public.xiaoc_memory_import_legacy('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'ombre',r.legacy_external_id,
    'validation/test-shadow-001.txt',r.fictitious_content,r.content_hash,'{}','{}',false,'active',null,null,0,'m2d-validation-policy-v1',r.retrieval_tier,null,'test','observation','m2d-validation-authority','m2d-validation-capture');
  if v_id1<>v_id2 or (select count(*) from public.memory_items where user_id='__xiaoc_m2d_validation_a__' and id=v_id1)<>1 then
    raise exception 'M2D_VALIDATION_FAILED: same-hash replay was not idempotent'; end if;
  if not exists(select 1 from public.memory_items where user_id='__xiaoc_m2d_validation_a__' and id=v_id1
    and memory_class='observation' and origin_system='ombre_legacy' and provenance_status='legacy_unverified') then
    raise exception 'M2D_VALIDATION_FAILED: legacy invariants were not enforced'; end if;

  v_failed:=false;
  begin perform public.xiaoc_memory_import_legacy('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'ombre',r.legacy_external_id,
    'validation/conflict.txt','DIFFERENT_FICTITIOUS_BODY',repeat('e',64),'{}','{}',false,'active',null,null,0,'m2d-validation-policy-v1',r.retrieval_tier,null,'test','observation','m2d-validation-authority','m2d-validation-capture');
  exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: different-hash identity was not rejected'; end if;
end
$validation$;

-- Missing data must prevent completion.
do $validation$
declare v_failed boolean:=false;
begin
  begin perform public.xiaoc_memory_finalize_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'applying','validation-finalize-missing');
  exception when others then v_failed:=position('M2D final validation failed' in sqlerrm)>0; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: incomplete run finalized'; end if;
end
$validation$;

-- Transaction-local fixtures fill the remaining locked plan without using real bodies.
insert into public.memory_operations(id,user_id,import_run_id,operation_type,idempotency_key,actor_type,policy_version,result_status,affected_memory_ids,completed_at)
select extensions.gen_random_uuid(),'__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),
  'legacy_import',(select id::text from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1')||':'||p.legacy_external_id||':'||p.content_hash,
  'migration','m2d-validation-policy-v1','success',array[p.deterministic_memory_id],now()
from public.memory_import_plan_items p where p.user_id='__xiaoc_m2d_validation_a__'
  and p.import_run_id=(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1')
  and p.legacy_external_id<>'test-shadow-001';

insert into public.memory_items(id,user_id,canonical_content,content_hash,origin_system,memory_class,category,provenance_status,
  lifecycle_status,retrieval_tier,authority_tier,authority_policy_version,capture_policy_version)
select deterministic_memory_id,'__xiaoc_m2d_validation_a__','FICTITIOUS_M2D_VALIDATION_MEMORY_'||legacy_external_id,content_hash,'ombre_legacy','observation','test',
  'legacy_unverified','active',retrieval_tier,authority_tier,'m2d-validation-authority','m2d-validation-capture'
from public.memory_import_plan_items where user_id='__xiaoc_m2d_validation_a__'
  and import_run_id=(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1')
  and legacy_external_id<>'test-shadow-001';

insert into public.legacy_memory_map(user_id,import_run_id,memory_id,source_system,legacy_external_id,original_relative_path,
  original_content,original_content_hash,original_metadata,original_lifecycle_hints,legacy_pin_candidate,original_archive_state,
  original_activation_count,legacy_policy_version,initial_retrieval_tier)
select '__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),deterministic_memory_id,'ombre',legacy_external_id,
  'validation/'||legacy_external_id||'.txt','FICTITIOUS_M2D_VALIDATION_MEMORY_'||legacy_external_id,content_hash,'{}','{}',false,'active',0,'m2d-validation-policy-v1',retrieval_tier
from public.memory_import_plan_items where user_id='__xiaoc_m2d_validation_a__'
  and import_run_id=(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1')
  and legacy_external_id<>'test-shadow-001';

-- Finalizer must reject classification, hash, provenance and authority corruption.
do $validation$
declare v_target uuid; v_op uuid; v_failed boolean;
begin
  select deterministic_memory_id into v_target from public.memory_import_plan_items where user_id='__xiaoc_m2d_validation_a__'
    and import_run_id=(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1')
    and retrieval_tier='shadow_only' limit 1;
  v_failed:=false;
  begin
    update public.memory_items set retrieval_tier='disabled',revision=revision+1 where user_id='__xiaoc_m2d_validation_a__' and id=v_target;
    perform public.xiaoc_memory_finalize_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'applying','validation-finalize-bad-class');
  exception when others then v_failed:=position('M2D final validation failed' in sqlerrm)>0; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: classification mismatch finalized'; end if;

  v_failed:=false;
  begin
    -- Transaction-local corruption fixture: replica mode suppresses the immutable
    -- trigger only inside this exception subtransaction; the expected finalizer
    -- exception rolls both the row change and this setting back immediately.
    set local session_replication_role = replica;
    update public.memory_items set content_hash=repeat('8',64),revision=revision+1 where user_id='__xiaoc_m2d_validation_a__' and id=v_target;
    perform public.xiaoc_memory_finalize_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'applying','validation-finalize-bad-hash');
  exception when others then v_failed:=position('M2D final validation failed' in sqlerrm)>0; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: hash mismatch finalized'; end if;

  insert into public.memory_operations(user_id,operation_type,idempotency_key,actor_type,policy_version,result_status,affected_memory_ids,completed_at)
    values('__xiaoc_m2d_validation_a__','manual_confirmation','validation-provenance-op','user','m2d-validation-policy-v1','success',array[v_target],now()) returning id into v_op;
  v_failed:=false;
  begin
    insert into public.memory_provenance(user_id,memory_id,source_kind,source_locator_key,source_operation_id,source_role,evidence_text,evidence_hash,evidence_type,observed_at)
      values('__xiaoc_m2d_validation_a__',v_target,'manual_user','manual:'||v_op,v_op,'user','FICTITIOUS_VALIDATION_EVIDENCE',
        encode(extensions.digest(convert_to('FICTITIOUS_VALIDATION_EVIDENCE','UTF8'),'sha256'),'hex'),'confirmation',now());
    perform public.xiaoc_memory_finalize_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'applying','validation-finalize-provenance');
  exception when others then v_failed:=position('M2D final validation failed' in sqlerrm)>0; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: unexpected provenance finalized'; end if;

  v_failed:=false;
  begin
    update public.memory_items set authority_tier='legacy_limited',retrieval_tier='low_authority',revision=revision+1
      where user_id='__xiaoc_m2d_validation_a__' and id=v_target;
    perform public.xiaoc_memory_finalize_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'applying','validation-finalize-authority');
  exception when others then v_failed:=position('M2D final validation failed' in sqlerrm)>0; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: unexpected authority finalized'; end if;
end
$validation$;

select public.xiaoc_memory_finalize_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'applying','validation-finalize-pass');

-- Terminal runs cannot reopen and cross-user finalize/rollback must fail.
do $validation$
declare v_failed boolean;
begin
  v_failed:=false; begin perform public.xiaoc_memory_start_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'planned','validation-terminal-reopen');
  exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: complete run reopened'; end if;
  v_failed:=false; begin perform public.xiaoc_memory_finalize_import_run('__xiaoc_m2d_validation_b__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'applying','validation-cross-finalize');
  exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: cross-user finalize succeeded'; end if;
  v_failed:=false; begin perform public.xiaoc_memory_rollback_import_run('__xiaoc_m2d_validation_b__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),(select classification_digest from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'validation-cross-rollback');
  exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: cross-user rollback succeeded'; end if;
end
$validation$;

-- Dependency guard: relation/verified descendant, PIN and embedding each block rollback.
do $validation$
declare v_target uuid; v_native uuid; v_op uuid; v_failed boolean;
begin
  select deterministic_memory_id into v_target from public.memory_import_plan_items where user_id='__xiaoc_m2d_validation_a__'
    and import_run_id=(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1') limit 1;
  v_failed:=false;
  begin
    insert into public.memory_operations(user_id,operation_type,idempotency_key,actor_type,policy_version,result_status,completed_at)
      values('__xiaoc_m2d_validation_a__','capture','validation-descendant-op','system','test','success',now()) returning id into v_op;
    insert into public.memory_items(user_id,canonical_content,content_hash,origin_system,memory_class,category,provenance_status,lifecycle_status,authority_tier,authority_policy_version,capture_policy_version)
      values('__xiaoc_m2d_validation_a__','FICTITIOUS_VERIFIED_DESCENDANT',encode(extensions.digest(convert_to('FICTITIOUS_VERIFIED_DESCENDANT','UTF8'),'sha256'),'hex'),
        'xiaoc_native','observation','test','manual_confirmed','active','native_verified','test','test') returning id into v_native;
    insert into public.memory_relations(user_id,from_memory_id,to_memory_id,relation_type,operation_id)
      values('__xiaoc_m2d_validation_a__',v_native,v_target,'revalidates',v_op);
    perform public.xiaoc_memory_rollback_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),(select classification_digest from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'validation-rollback-relation');
  exception when others then v_failed:=position('downstream dependency' in sqlerrm)>0; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: relation/descendant did not block rollback'; end if;

  v_failed:=false;
  begin
    insert into public.memory_operations(user_id,operation_type,idempotency_key,actor_type,policy_version,result_status,completed_at)
      values('__xiaoc_m2d_validation_a__','pin','validation-pin-op','user','test','success',now()) returning id into v_op;
    insert into public.memory_pins(user_id,memory_id,scope,ordinal,pin_status,pinned_by,operation_id,pinned_at)
      values('__xiaoc_m2d_validation_a__',v_target,'core',999,'active','migration',v_op,now());
    perform public.xiaoc_memory_rollback_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),(select classification_digest from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'validation-rollback-pin');
  exception when others then v_failed:=position('downstream dependency' in sqlerrm)>0; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: PIN did not block rollback'; end if;

  v_failed:=false;
  begin
    insert into public.memory_embeddings(user_id,memory_id,provider,model,embedding_version,preprocessor_version,dimensions,content_hash,embedding,rollout_status)
      select '__xiaoc_m2d_validation_a__',id,'validation','validation','v1','v1',1,content_hash,'[0]'::extensions.vector,'shadow'
      from public.memory_items where user_id='__xiaoc_m2d_validation_a__' and id=v_target;
    perform public.xiaoc_memory_rollback_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),(select classification_digest from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'validation-rollback-embedding');
  exception when others then v_failed:=position('downstream dependency' in sqlerrm)>0; end;
  if not v_failed then raise exception 'M2D_VALIDATION_FAILED: embedding did not block rollback'; end if;
end
$validation$;

-- Normal rollback and replay.
select public.xiaoc_memory_rollback_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),(select classification_digest from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'validation-rollback-pass');
select public.xiaoc_memory_rollback_import_run('__xiaoc_m2d_validation_a__',(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),(select classification_digest from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1'),'validation-rollback-pass');

-- A separate valid planned -> failed path.
do $validation$
declare v_plan jsonb; v_class text; v_order text; v_run uuid;
begin
  select jsonb_agg(jsonb_build_object('ordinal',ordinal,'legacy_external_id',legacy_external_id,'content_hash',content_hash,
    'deterministic_memory_id',deterministic_memory_id,'retrieval_tier',retrieval_tier,'authority_tier',authority_tier,'reason_codes',reason_codes) order by ordinal)
    into v_plan from public.memory_import_plan_items where user_id='__xiaoc_m2d_validation_a__'
      and import_run_id=(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1');
  -- Recompute deterministic IDs for user B, then recompute both digests.
  select jsonb_agg(e order by (e->>'ordinal')::int) into v_plan from (
    select jsonb_set(x,'{deterministic_memory_id}',to_jsonb(extensions.uuid_generate_v5('f1c7e436-ff13-5d2c-8e4a-5de7386b6db7'::uuid,
      '__xiaoc_m2d_validation_b__'||chr(31)||'ombre'||chr(31)||(x->>'legacy_external_id')))) e from jsonb_array_elements(v_plan) x) q;
  select encode(extensions.digest(convert_to(string_agg(legacy_external_id||chr(31)||content_hash||chr(31)||deterministic_memory_id::text||chr(31)||retrieval_tier||chr(31)||authority_tier,chr(30) order by legacy_external_id collate "C"),'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to(string_agg(ordinal::text||chr(31)||legacy_external_id||chr(31)||content_hash||chr(31)||deterministic_memory_id::text,chr(30) order by ordinal),'UTF8'),'sha256'),'hex')
    into v_class,v_order from jsonb_to_recordset(v_plan) x(ordinal int,legacy_external_id text,content_hash text,deterministic_memory_id uuid,retrieval_tier text,authority_tier text);
  v_run:=public.xiaoc_memory_create_import_run('__xiaoc_m2d_validation_b__','ombre',repeat('1',64),repeat('2',64),v_order,v_class,150,
    'm2d-validation-policy-v2','m2d-validation-importer-v2',v_plan,'validation-create-b');
  perform public.xiaoc_memory_fail_import_run('__xiaoc_m2d_validation_b__',v_run,'planned','VALIDATION_EXPECTED_FAILURE','validation-fail-b');
  if not exists(select 1 from public.memory_import_runs where user_id='__xiaoc_m2d_validation_b__' and id=v_run and run_status='failed') then
    raise exception 'M2D_VALIDATION_FAILED: planned to failed transition failed'; end if;
end
$validation$;

-- Audit, retention and permission checks.
do $validation$
declare v_run uuid:=(select id from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and importer_version='m2d-validation-importer-v1');
begin
  if (select count(*) from public.memory_items where user_id='__xiaoc_m2d_validation_a__' and retrieval_tier='disabled' and authority_tier='none')<>150
    or (select count(*) from public.legacy_memory_map where user_id='__xiaoc_m2d_validation_a__' and import_run_id=v_run)<>150
    or (select count(*) from public.memory_import_plan_items where user_id='__xiaoc_m2d_validation_a__' and import_run_id=v_run)<>150
    or not exists(select 1 from public.memory_import_runs where user_id='__xiaoc_m2d_validation_a__' and id=v_run and run_status='disabled') then
    raise exception 'M2D_VALIDATION_FAILED: rollback did not retain and disable the complete batch';
  end if;
  if (select count(*) from public.memory_operations where user_id='__xiaoc_m2d_validation_a__' and import_run_id=v_run and operation_type='legacy_import' and result_status='success')<>150
    or not exists(select 1 from public.memory_operations where user_id='__xiaoc_m2d_validation_a__' and import_run_id=v_run and operation_type='legacy_import_run_create' and result_status='success')
    or not exists(select 1 from public.memory_operations where user_id='__xiaoc_m2d_validation_a__' and import_run_id=v_run and operation_type='legacy_import_finalize' and result_status='success')
    or not exists(select 1 from public.memory_operations where user_id='__xiaoc_m2d_validation_a__' and import_run_id=v_run and operation_type='legacy_import_rollback' and result_status='success') then
    raise exception 'M2D_VALIDATION_FAILED: operation ledger linkage/status incomplete';
  end if;
  if exists(select 1 from public.memory_operations where user_id like '__xiaoc_m2d_validation_%'
    and (coalesce(before_state,'{}')::text like '%FICTITIOUS_M2D_VALIDATION_MEMORY_%'
      or coalesce(after_state,'{}')::text like '%FICTITIOUS_M2D_VALIDATION_MEMORY_%')) then
    raise exception 'M2D_VALIDATION_FAILED: operation ledger contains Memory body'; end if;

  if has_table_privilege('service_role','public.memory_import_runs','INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role','public.memory_import_plan_items','INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role','public.memory_operations','INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated','public.memory_import_runs','INSERT,UPDATE,DELETE')
    or has_table_privilege('anon','public.memory_import_runs','INSERT,UPDATE,DELETE') then
    raise exception 'M2D_VALIDATION_FAILED: protected direct mutation privilege exists'; end if;
  if not has_function_privilege('service_role','public.xiaoc_memory_create_import_run(text,text,text,text,text,text,integer,text,text,jsonb,text)','EXECUTE')
    or has_function_privilege('authenticated','public.xiaoc_memory_create_import_run(text,text,text,text,text,text,integer,text,text,jsonb,text)','EXECUTE')
    or has_function_privilege('anon','public.xiaoc_memory_create_import_run(text,text,text,text,text,text,integer,text,text,jsonb,text)','EXECUTE') then
    raise exception 'M2D_VALIDATION_FAILED: protected RPC grants are incorrect'; end if;
end
$validation$;

select
  'M2D_VALIDATION_PASS' as result,
  (select count(*) from public.memory_items where user_id='__xiaoc_m2d_validation_a__') as validated_memory_count,
  (select count(*) from public.legacy_memory_map where user_id='__xiaoc_m2d_validation_a__') as validated_map_count,
  (select count(*) from public.memory_operations where user_id like '__xiaoc_m2d_validation_%') as validated_operation_count,
  (select count(*) from public.memory_items where user_id='__xiaoc_m2d_validation_a__' and retrieval_tier='low_authority') as low_authority_after_rollback,
  (select count(*) from public.memory_items where user_id='__xiaoc_m2d_validation_a__' and retrieval_tier='disabled') as disabled_after_rollback;

rollback;

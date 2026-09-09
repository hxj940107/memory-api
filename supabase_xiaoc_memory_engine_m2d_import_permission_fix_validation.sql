-- XiaoC Memory Engine M2D import permission fix validation.
-- Run the whole file once in Supabase SQL Editor. All data is fictitious and
-- the transaction always ends with ROLLBACK. It never references the real run.

begin;

do $validation$
declare
  v_trigger regprocedure := to_regprocedure('public.xiaoc_memory_deferred_integrity_trigger()');
  v_helper regprocedure := to_regprocedure('public.xiaoc_memory_assert_verified_integrity(text,uuid)');
  v_import regprocedure := to_regprocedure('public.xiaoc_memory_import_legacy(text,uuid,text,text,text,text,text,jsonb,jsonb,boolean,text,timestamptz,timestamptz,integer,text,text,text,text,text,text,text)');
begin
  if v_trigger is null or v_helper is null or v_import is null then
    raise exception 'M2D_PERMISSION_VALIDATION_FAILED: required function missing';
  end if;
  if not (select p.prosecdef and r.rolname='postgres'
          from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=v_trigger) then
    raise exception 'M2D_PERMISSION_VALIDATION_FAILED: deferred trigger is not postgres-owned SECURITY DEFINER';
  end if;
  if not (select p.prosecdef and r.rolname='postgres'
          from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=v_import) then
    raise exception 'M2D_PERMISSION_VALIDATION_FAILED: import RPC is not postgres-owned SECURITY DEFINER';
  end if;
  if has_function_privilege('service_role',v_trigger,'EXECUTE')
    or has_function_privilege('service_role',v_helper,'EXECUTE')
    or has_function_privilege('anon',v_helper,'EXECUTE')
    or has_function_privilege('authenticated',v_helper,'EXECUTE') then
    raise exception 'M2D_PERMISSION_VALIDATION_FAILED: private integrity function is directly callable';
  end if;
  if not has_function_privilege('service_role',v_import,'EXECUTE') then
    raise exception 'M2D_PERMISSION_VALIDATION_FAILED: service_role cannot execute protected import RPC';
  end if;
  if has_table_privilege('service_role','public.memory_items','INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role','public.legacy_memory_map','INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role','public.memory_import_runs','INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role','public.memory_import_plan_items','INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role','public.memory_operations','INSERT,UPDATE,DELETE') then
    raise exception 'M2D_PERMISSION_VALIDATION_FAILED: direct mutation privilege was widened';
  end if;
  if exists(select 1 from public.memory_import_runs where user_id='__xiaoc_m2d_permission_validation__') then
    raise exception 'M2D_PERMISSION_VALIDATION_FAILED: prior validation residue exists';
  end if;
end
$validation$;

set local role service_role;

do $validation$
declare
  v_plan jsonb;
  v_class text;
  v_order text;
  v_run uuid;
  v_item uuid;
  v_expected uuid;
  v_direct_failed boolean;
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
    union all
    select 'permission-shadow-'||lpad(g::text,3,'0'),
      encode(extensions.digest(convert_to('FICTITIOUS_PERMISSION_MEMORY_permission-shadow-'||lpad(g::text,3,'0'),'UTF8'),'sha256'),'hex'),
      'shadow_only',array['PERMISSION_TEST_FIXTURE']::text[] from generate_series(1,95) g
    union all
    select 'permission-disabled-'||lpad(g::text,3,'0'),
      encode(extensions.digest(convert_to('FICTITIOUS_PERMISSION_MEMORY_permission-disabled-'||lpad(g::text,3,'0'),'UTF8'),'sha256'),'hex'),
      'disabled',array['PERMISSION_TEST_FIXTURE']::text[] from generate_series(1,49) g
  ), plan_seed as (
    select (row_number() over(order by legacy_external_id collate "C")-1)::int ordinal,
      legacy_external_id,content_hash,
      extensions.uuid_generate_v5('f1c7e436-ff13-5d2c-8e4a-5de7386b6db7'::uuid,
        '__xiaoc_m2d_permission_validation__'||chr(31)||'ombre'||chr(31)||legacy_external_id) deterministic_memory_id,
      retrieval_tier,case when retrieval_tier='low_authority' then 'legacy_limited' else 'none' end authority_tier,
      reason_codes
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

  v_run := public.xiaoc_memory_create_import_run(
    '__xiaoc_m2d_permission_validation__','ombre',repeat('a',64),repeat('b',64),v_order,v_class,150,
    'm2d-permission-validation-v1','m2d-permission-validation-importer-v1',v_plan,'permission-create');
  perform public.xiaoc_memory_start_import_run(
    '__xiaoc_m2d_permission_validation__',v_run,'planned','permission-start');

  v_expected := extensions.uuid_generate_v5(
    'f1c7e436-ff13-5d2c-8e4a-5de7386b6db7'::uuid,
    '__xiaoc_m2d_permission_validation__'||chr(31)||'ombre'||chr(31)||'permission-shadow-001');
  v_item := public.xiaoc_memory_import_legacy(
    '__xiaoc_m2d_permission_validation__',v_run,'ombre','permission-shadow-001',
    'validation/permission-shadow-001.md','FICTITIOUS_PERMISSION_MEMORY_permission-shadow-001',
    encode(extensions.digest(convert_to('FICTITIOUS_PERMISSION_MEMORY_permission-shadow-001','UTF8'),'sha256'),'hex'),
    '{}','{}',false,'live',null,null,0,'m2d-permission-validation-v1','shadow_only',null,
    'permission_test','observation','m2d-permission-validation-v1','m2d-permission-validation-v1');
  if v_item<>v_expected then
    raise exception 'M2D_PERMISSION_VALIDATION_FAILED: protected import returned wrong deterministic ID';
  end if;
  if (select count(*) from public.memory_items where user_id='__xiaoc_m2d_permission_validation__' and id=v_item)<>1
    or (select count(*) from public.legacy_memory_map where user_id='__xiaoc_m2d_permission_validation__' and import_run_id=v_run)<>1
    or (select count(*) from public.memory_operations where user_id='__xiaoc_m2d_permission_validation__'
      and import_run_id=v_run and operation_type='legacy_import' and result_status='success')<>1 then
    raise exception 'M2D_PERMISSION_VALIDATION_FAILED: protected import did not atomically create its test rows';
  end if;

  v_direct_failed:=false;
  begin
    insert into public.memory_items(user_id,canonical_content,content_hash,origin_system,memory_class,category,
      provenance_status,lifecycle_status,authority_tier,authority_policy_version,capture_policy_version)
    values('__xiaoc_m2d_permission_validation__','FICTITIOUS_DIRECT_INSERT',repeat('0',64),'ombre_legacy',
      'observation','test','legacy_unverified','active','none','test','test');
  exception when insufficient_privilege then v_direct_failed:=true; end;
  if not v_direct_failed then raise exception 'M2D_PERMISSION_VALIDATION_FAILED: direct memory_items insert succeeded'; end if;

  v_direct_failed:=false;
  begin
    insert into public.legacy_memory_map(user_id,import_run_id,memory_id,source_system,legacy_external_id,
      original_relative_path,original_content,original_content_hash,legacy_policy_version,initial_retrieval_tier)
    values('__xiaoc_m2d_permission_validation__',v_run,v_item,'ombre','direct-map-attempt','validation/direct.md',
      'FICTITIOUS_DIRECT_MAP',repeat('0',64),'test','shadow_only');
  exception when insufficient_privilege then v_direct_failed:=true; end;
  if not v_direct_failed then raise exception 'M2D_PERMISSION_VALIDATION_FAILED: direct legacy map insert succeeded'; end if;

  v_direct_failed:=false;
  begin
    update public.memory_import_runs set run_status='failed'
    where user_id='__xiaoc_m2d_permission_validation__' and id=v_run;
  exception when insufficient_privilege then v_direct_failed:=true; end;
  if not v_direct_failed then raise exception 'M2D_PERMISSION_VALIDATION_FAILED: direct protected state update succeeded'; end if;
end
$validation$;

reset role;

select 'XIAOC_MEMORY_ENGINE_M2D_IMPORT_PERMISSION_FIX_VALIDATION_PASS' as validation_result;

rollback;

-- XiaoC Memory Engine M2D schema hardening.
-- Forward-only and additive. This file does not import historical Memory data.

alter table public.memory_import_runs
  add column manifest_sha256 text,
  add column execution_order_digest text,
  add column classification_digest text,
  add column expected_record_count integer,
  add column policy_version text,
  add column started_at timestamptz,
  add column failed_at timestamptz,
  add column failure_reason_code text,
  add constraint memory_import_runs_manifest_sha256_check
    check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint memory_import_runs_execution_order_digest_check
    check (execution_order_digest ~ '^[0-9a-f]{64}$'),
  add constraint memory_import_runs_classification_digest_check
    check (classification_digest ~ '^[0-9a-f]{64}$'),
  add constraint memory_import_runs_expected_record_count_check
    check (expected_record_count > 0),
  add constraint memory_import_runs_policy_version_check
    check (btrim(policy_version) <> '');

create table public.memory_import_plan_items (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  import_run_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  legacy_external_id text not null check (btrim(legacy_external_id) <> ''),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  deterministic_memory_id uuid not null,
  retrieval_tier text not null check (retrieval_tier in ('low_authority', 'shadow_only', 'disabled')),
  authority_tier text not null check (
    (retrieval_tier = 'low_authority' and authority_tier = 'legacy_limited')
    or (retrieval_tier in ('shadow_only', 'disabled') and authority_tier = 'none')
  ),
  reason_codes text[] not null check (cardinality(reason_codes) > 0),
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, import_run_id, ordinal),
  unique (user_id, import_run_id, legacy_external_id),
  unique (user_id, import_run_id, deterministic_memory_id),
  foreign key (user_id, import_run_id)
    references public.memory_import_runs (user_id, id)
);

alter table public.memory_operations add column import_run_id uuid;
alter table public.memory_operations add constraint memory_operations_import_run_fk
  foreign key (user_id, import_run_id) references public.memory_import_runs (user_id, id);
create index memory_operations_import_run_idx
  on public.memory_operations (user_id, import_run_id, created_at);

create or replace function public.xiaoc_memory_guard_import_run()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
begin
  if row(new.id, new.user_id, new.source_system, new.source_archive_sha256,
    new.importer_version, new.legacy_policy_version, new.source_file_count,
    new.planned_count, new.manifest_sha256, new.execution_order_digest,
    new.classification_digest, new.expected_record_count, new.policy_version,
    new.created_at)
    is distinct from
    row(old.id, old.user_id, old.source_system, old.source_archive_sha256,
    old.importer_version, old.legacy_policy_version, old.source_file_count,
    old.planned_count, old.manifest_sha256, old.execution_order_digest,
    old.classification_digest, old.expected_record_count, old.policy_version,
    old.created_at) then
    raise exception 'immutable import run contract cannot be changed';
  end if;
  if not (
    (old.run_status = 'planned' and new.run_status in ('applying', 'failed'))
    or (old.run_status = 'applying' and new.run_status in ('complete', 'failed'))
    or (old.run_status in ('complete', 'failed') and new.run_status = 'disabled')
  ) then raise exception 'invalid import run transition'; end if;
  return new;
end;
$$;
create trigger memory_import_runs_transition_guard
before update on public.memory_import_runs
for each row execute function public.xiaoc_memory_guard_import_run();
create trigger memory_import_runs_no_delete_guard
before delete on public.memory_import_runs
for each row execute function public.xiaoc_memory_guard_append_only();

create trigger memory_import_plan_items_append_only_guard
before update or delete on public.memory_import_plan_items
for each row execute function public.xiaoc_memory_guard_append_only();

create or replace function public.xiaoc_memory_guard_operation_transition()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
begin
  if row(new.id, new.user_id, new.operation_type, new.idempotency_key,
    new.actor_type, new.policy_version, new.compensates_operation_id,
    new.import_run_id, new.created_at)
    is distinct from
    row(old.id, old.user_id, old.operation_type, old.idempotency_key,
    old.actor_type, old.policy_version, old.compensates_operation_id,
    old.import_run_id, old.created_at) then
    raise exception 'operation identity fields cannot be changed';
  end if;
  if old.result_status <> 'started' then raise exception 'terminal operation cannot be changed'; end if;
  if new.result_status not in ('success', 'failed', 'cancelled') then
    raise exception 'operation may only transition from started to terminal';
  end if;
  return new;
end;
$$;

drop function public.xiaoc_memory_create_import_run(text,text,text,text,text,integer,integer);
create function public.xiaoc_memory_create_import_run(
  p_user_id text, p_source_system text, p_source_snapshot_sha256 text,
  p_manifest_sha256 text, p_execution_order_digest text,
  p_classification_digest text, p_expected_record_count integer,
  p_policy_version text, p_importer_version text, p_plan jsonb,
  p_idempotency_key text
) returns uuid language plpgsql security definer
set search_path = public, extensions, pg_catalog as $$
declare v_run_id uuid; v_operation_id uuid; v_computed text; v_order text; v_namespace constant uuid := 'f1c7e436-ff13-5d2c-8e4a-5de7386b6db7';
begin
  if p_source_system <> 'ombre' or p_expected_record_count <> 150
    or jsonb_typeof(p_plan) <> 'array' or jsonb_array_length(p_plan) <> 150 then
    raise exception 'locked M2D source contract required';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_plan) x(ordinal int, legacy_external_id text,
    content_hash text, deterministic_memory_id uuid, retrieval_tier text, authority_tier text, reason_codes text[])
    where ordinal is null or legacy_external_id is null or content_hash !~ '^[0-9a-f]{64}$'
      or deterministic_memory_id <> extensions.uuid_generate_v5(v_namespace,
        p_user_id || chr(31) || p_source_system || chr(31) || legacy_external_id)
      or retrieval_tier not in ('low_authority','shadow_only','disabled')
      or authority_tier <> case when retrieval_tier='low_authority' then 'legacy_limited' else 'none' end
      or cardinality(reason_codes) = 0) then raise exception 'invalid classification plan item'; end if;
  if (select count(distinct legacy_external_id) from jsonb_to_recordset(p_plan) x(legacy_external_id text)) <> 150
    or (select count(distinct deterministic_memory_id) from jsonb_to_recordset(p_plan) x(deterministic_memory_id uuid)) <> 150
    or (select min(ordinal)<>0 or max(ordinal)<>149 or count(distinct ordinal)<>150
        from jsonb_to_recordset(p_plan) x(ordinal int))
    or (select count(*) from jsonb_to_recordset(p_plan) x(retrieval_tier text) where retrieval_tier='low_authority') <> 6
    or (select count(*) from jsonb_to_recordset(p_plan) x(retrieval_tier text) where retrieval_tier='shadow_only') <> 95
    or (select count(*) from jsonb_to_recordset(p_plan) x(retrieval_tier text) where retrieval_tier='disabled') <> 49 then
    raise exception 'classification plan must be exactly 0/6/95/49';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_plan) x(legacy_external_id text,content_hash text,
      deterministic_memory_id uuid,retrieval_tier text,reason_codes text[])
    where retrieval_tier='low_authority' and (legacy_external_id,content_hash,reason_codes) not in (
      values
      ('ffb8ce86aa3b','0458ba7f6948ed79cf9ac8f6d66fe1270c5c49beab3ea6edf9c0e35be3a15244',array['LOW_RISK_DYNAMIC_DOMAIN','LEGACY_UNVERIFIED','STRONG_RELEVANCE_REQUIRED']::text[]),
      ('632959ffb312','63409c97c8ce34bdb88f749fcbea405ebd35a928e66ad87d3a138eaad791d7b6',array['HISTORICAL_CONTINUITY_REVIEW_APPROVED','EXPLICIT_PAST_FRAMING','NO_HIGH_AUTHORITY_MARKER']::text[]),
      ('8815e2b2c20a','66df447a878f179aaccbac98c90bbdd741a6debfb0ae920973f3d68172417a72',array['HISTORICAL_CONTINUITY_REVIEW_APPROVED','HISTORICAL_EVENT_SIGNAL','NO_HIGH_AUTHORITY_MARKER']::text[]),
      ('f4c1457bd8d3','4b88854ce96d0f4034bbfd18314eabfdd446a45d307ed86c2975735d4c90ffbb',array['HISTORICAL_CONTINUITY_REVIEW_APPROVED','HISTORICAL_EVENT_SIGNAL','NO_HIGH_AUTHORITY_MARKER']::text[]),
      ('1d16fc964753','54398556b3fa29cb00a29cc1b17dcb3eff72f72a6664b0cf668215255925c1d8',array['HISTORICAL_CONTINUITY_REVIEW_APPROVED','EXPLICIT_PAST_FRAMING','NO_HIGH_AUTHORITY_MARKER']::text[]),
      ('b4db8014d06e','4f0bbdc4de42a4631d16dcec1bdecf0c7a4c7024e5eb02a37689267f8ea2cafe',array['HISTORICAL_CONTINUITY_REVIEW_APPROVED','HISTORICAL_EVENT_SIGNAL','NO_HIGH_AUTHORITY_MARKER']::text[])
    )
  ) then raise exception 'low-authority item is not in the locked allowlist'; end if;
  select encode(extensions.digest(convert_to(string_agg(
    legacy_external_id||chr(31)||content_hash||chr(31)||deterministic_memory_id::text||chr(31)||retrieval_tier||chr(31)||authority_tier,
    chr(30) order by legacy_external_id collate "C"),'UTF8'),'sha256'),'hex') into v_computed
  from jsonb_to_recordset(p_plan) x(legacy_external_id text,content_hash text,deterministic_memory_id uuid,retrieval_tier text,authority_tier text);
  if v_computed <> p_classification_digest then raise exception 'classification digest mismatch'; end if;
  select encode(extensions.digest(convert_to(string_agg(
    ordinal::text||chr(31)||legacy_external_id||chr(31)||content_hash||chr(31)||deterministic_memory_id::text,
    chr(30) order by ordinal),'UTF8'),'sha256'),'hex') into v_order
  from jsonb_to_recordset(p_plan) x(ordinal int,legacy_external_id text,content_hash text,deterministic_memory_id uuid);
  if v_order <> p_execution_order_digest then raise exception 'execution order digest mismatch'; end if;
  insert into public.memory_import_runs(user_id,source_system,source_archive_sha256,importer_version,
    legacy_policy_version,source_file_count,planned_count,manifest_sha256,execution_order_digest,
    classification_digest,expected_record_count,policy_version)
  values(p_user_id,p_source_system,p_source_snapshot_sha256,p_importer_version,p_policy_version,
    p_expected_record_count,p_expected_record_count,p_manifest_sha256,p_execution_order_digest,
    p_classification_digest,p_expected_record_count,p_policy_version)
  on conflict(user_id,source_system,source_archive_sha256,importer_version,legacy_policy_version) do nothing returning id into v_run_id;
  if v_run_id is null then
    select id into v_run_id from public.memory_import_runs where user_id=p_user_id and source_system=p_source_system
      and source_archive_sha256=p_source_snapshot_sha256 and importer_version=p_importer_version and legacy_policy_version=p_policy_version
      and manifest_sha256=p_manifest_sha256 and execution_order_digest=p_execution_order_digest
      and classification_digest=p_classification_digest and expected_record_count=p_expected_record_count;
    if v_run_id is null then raise exception 'existing run has a different immutable source contract'; end if;
    return v_run_id;
  end if;
  insert into public.memory_import_plan_items(user_id,import_run_id,ordinal,legacy_external_id,content_hash,
    deterministic_memory_id,retrieval_tier,authority_tier,reason_codes)
  select p_user_id,v_run_id,ordinal,legacy_external_id,content_hash,deterministic_memory_id,retrieval_tier,authority_tier,reason_codes
  from jsonb_to_recordset(p_plan) x(ordinal int,legacy_external_id text,content_hash text,
    deterministic_memory_id uuid,retrieval_tier text,authority_tier text,reason_codes text[]);
  insert into public.memory_operations(user_id,import_run_id,operation_type,idempotency_key,actor_type,policy_version)
  values(p_user_id,v_run_id,'legacy_import_run_create',p_idempotency_key,'migration',p_policy_version) returning id into v_operation_id;
  perform public.xiaoc_memory_finish_operation(p_user_id,v_operation_id,'success',null,'{}'::uuid[],null,
    jsonb_build_object('expected_record_count',150,'classification_digest',p_classification_digest));
  return v_run_id;
end;
$$;

create function public.xiaoc_memory_start_import_run(p_user_id text,p_import_run_id uuid,p_expected_status text,p_idempotency_key text)
returns uuid language plpgsql security definer set search_path=public,extensions,pg_catalog as $$
declare v_op uuid;
begin
  if p_expected_status <> 'planned' then raise exception 'expected status must be planned'; end if;
  update public.memory_import_runs set run_status='applying',started_at=now()
    where user_id=p_user_id and id=p_import_run_id and run_status=p_expected_status;
  if not found then raise exception 'same-user planned run required'; end if;
  insert into public.memory_operations(user_id,import_run_id,operation_type,idempotency_key,actor_type,policy_version)
    select user_id,id,'legacy_import_run_start',p_idempotency_key,'migration',policy_version from public.memory_import_runs
    where user_id=p_user_id and id=p_import_run_id returning id into v_op;
  perform public.xiaoc_memory_finish_operation(p_user_id,v_op,'success',null,'{}'::uuid[]);
  return p_import_run_id;
end; $$;

create function public.xiaoc_memory_fail_import_run(p_user_id text,p_import_run_id uuid,p_expected_status text,p_reason_code text,p_idempotency_key text)
returns uuid language plpgsql security definer set search_path=public,extensions,pg_catalog as $$
declare v_op uuid;
begin
  if p_expected_status not in ('planned','applying') or p_reason_code !~ '^[A-Z0-9_]{1,64}$' then raise exception 'invalid failure transition'; end if;
  update public.memory_import_runs set run_status='failed',failed_at=now(),failure_reason_code=p_reason_code
    where user_id=p_user_id and id=p_import_run_id and run_status=p_expected_status;
  if not found then raise exception 'same-user run in expected state required'; end if;
  insert into public.memory_operations(user_id,import_run_id,operation_type,idempotency_key,actor_type,policy_version,result_status,reason_code,completed_at)
    select user_id,id,'legacy_import_run_fail',p_idempotency_key,'migration',policy_version,'failed',p_reason_code,now()
    from public.memory_import_runs where user_id=p_user_id and id=p_import_run_id returning id into v_op;
  return v_op;
end; $$;

create or replace function public.xiaoc_memory_import_legacy(
  p_user_id text,p_import_run_id uuid,p_source_system text,p_legacy_external_id text,p_original_relative_path text,
  p_original_content text,p_original_content_hash text,p_original_metadata jsonb,p_original_lifecycle_hints jsonb,
  p_legacy_pin_candidate boolean,p_original_archive_state text,p_original_created_at timestamptz,
  p_original_last_active_at timestamptz,p_original_activation_count integer,p_legacy_policy_version text,
  p_initial_retrieval_tier text,p_legacy_duplicate_cluster_id text,p_category text,p_memory_class text,
  p_authority_policy_version text,p_capture_policy_version text
) returns uuid language plpgsql security definer set search_path=public,extensions,pg_catalog as $$
declare v_namespace constant uuid := 'f1c7e436-ff13-5d2c-8e4a-5de7386b6db7'; v_memory_id uuid; v_operation_id uuid; v_existing_hash text; v_authority text;
begin
  if p_memory_class <> 'observation' then raise exception 'legacy memory_class must be observation'; end if;
  v_memory_id:=extensions.uuid_generate_v5(v_namespace,p_user_id||chr(31)||p_source_system||chr(31)||p_legacy_external_id);
  select authority_tier into v_authority from public.memory_import_plan_items pi join public.memory_import_runs r
    on r.user_id=pi.user_id and r.id=pi.import_run_id
    where pi.user_id=p_user_id and pi.import_run_id=p_import_run_id and r.run_status='applying'
      and r.source_system=p_source_system and r.policy_version=p_legacy_policy_version
      and pi.legacy_external_id=p_legacy_external_id and pi.content_hash=p_original_content_hash
      and pi.deterministic_memory_id=v_memory_id and pi.retrieval_tier=p_initial_retrieval_tier;
  if not found then raise exception 'legacy payload is not in locked classification plan'; end if;
  if p_initial_retrieval_tier='active_legacy' then raise exception 'active_legacy is not approved for M2D'; end if;
  if p_original_content_hash<>encode(extensions.digest(convert_to(p_original_content,'UTF8'),'sha256'),'hex') then raise exception 'legacy original content hash mismatch'; end if;
  select content_hash into v_existing_hash from public.memory_items where user_id=p_user_id and id=v_memory_id for update;
  if found then
    if v_existing_hash<>p_original_content_hash or not exists(select 1 from public.legacy_memory_map where user_id=p_user_id
      and import_run_id=p_import_run_id and memory_id=v_memory_id and original_content_hash=p_original_content_hash) then
      raise exception 'legacy identity content hash conflict'; end if;
    return v_memory_id;
  end if;
  insert into public.memory_operations(user_id,import_run_id,operation_type,idempotency_key,actor_type,policy_version)
    values(p_user_id,p_import_run_id,'legacy_import',p_import_run_id::text||':'||p_legacy_external_id||':'||p_original_content_hash,
      'migration',p_legacy_policy_version) returning id into v_operation_id;
  insert into public.memory_items(id,user_id,canonical_content,content_hash,origin_system,memory_class,category,
    provenance_status,lifecycle_status,retrieval_tier,authority_tier,authority_policy_version,capture_policy_version,created_at,updated_at)
    values(v_memory_id,p_user_id,p_original_content,p_original_content_hash,'ombre_legacy','observation',p_category,
      'legacy_unverified','active',p_initial_retrieval_tier,v_authority,p_authority_policy_version,p_capture_policy_version,
      coalesce(p_original_created_at,now()),now());
  insert into public.legacy_memory_map(user_id,import_run_id,memory_id,source_system,legacy_external_id,original_relative_path,
    original_content,original_content_hash,original_metadata,original_lifecycle_hints,legacy_pin_candidate,original_archive_state,
    original_created_at,original_last_active_at,original_activation_count,legacy_policy_version,initial_retrieval_tier,legacy_duplicate_cluster_id)
    values(p_user_id,p_import_run_id,v_memory_id,p_source_system,p_legacy_external_id,p_original_relative_path,p_original_content,
      p_original_content_hash,coalesce(p_original_metadata,'{}'),coalesce(p_original_lifecycle_hints,'{}'),p_legacy_pin_candidate,
      p_original_archive_state,p_original_created_at,p_original_last_active_at,p_original_activation_count,p_legacy_policy_version,
      p_initial_retrieval_tier,p_legacy_duplicate_cluster_id);
  perform public.xiaoc_memory_finish_operation(p_user_id,v_operation_id,'success',null,array[v_memory_id]);
  return v_memory_id;
end; $$;

create function public.xiaoc_memory_finalize_import_run(p_user_id text,p_import_run_id uuid,p_expected_status text,p_idempotency_key text)
returns uuid language plpgsql security definer set search_path=public,extensions,pg_catalog as $$
declare v_op uuid; v_count int; v_tiers jsonb; v_ids uuid[];
begin
  if p_expected_status<>'applying' then raise exception 'expected status must be applying'; end if;
  perform 1 from public.memory_import_runs where user_id=p_user_id and id=p_import_run_id and run_status='applying' for update;
  if not found then raise exception 'same-user applying run required'; end if;
  select count(*),array_agg(m.memory_id order by m.memory_id) into v_count,v_ids from public.legacy_memory_map m
    join public.memory_import_plan_items p on p.user_id=m.user_id and p.import_run_id=m.import_run_id
      and p.legacy_external_id=m.legacy_external_id and p.content_hash=m.original_content_hash and p.deterministic_memory_id=m.memory_id
      and p.retrieval_tier=m.initial_retrieval_tier
    join public.memory_items i on i.user_id=m.user_id and i.id=m.memory_id and i.content_hash=m.original_content_hash
      and i.origin_system='ombre_legacy' and i.memory_class='observation' and i.provenance_status='legacy_unverified'
      and i.lifecycle_status='active' and i.retrieval_tier=p.retrieval_tier and i.authority_tier=p.authority_tier
    where m.user_id=p_user_id and m.import_run_id=p_import_run_id;
  if v_count<>150 or (select count(*) from public.legacy_memory_map where user_id=p_user_id and import_run_id=p_import_run_id)<>150
    or (select count(*) from public.memory_import_plan_items where user_id=p_user_id and import_run_id=p_import_run_id)<>150
    or (select count(*) from public.memory_items where user_id=p_user_id and id=any(v_ids) and retrieval_tier='low_authority')<>6
    or (select count(*) from public.memory_items where user_id=p_user_id and id=any(v_ids) and retrieval_tier='shadow_only')<>95
    or (select count(*) from public.memory_items where user_id=p_user_id and id=any(v_ids) and retrieval_tier='disabled')<>49
    or exists(select 1 from public.memory_provenance where user_id=p_user_id and memory_id=any(v_ids))
    or exists(select 1 from public.memory_pins where user_id=p_user_id and memory_id=any(v_ids))
    or exists(select 1 from public.memory_embeddings where user_id=p_user_id and memory_id=any(v_ids))
    or (select count(*) from public.memory_operations where user_id=p_user_id and import_run_id=p_import_run_id
      and operation_type='legacy_import' and result_status='success')<>150 then
    raise exception 'M2D final validation failed';
  end if;
  v_tiers:=jsonb_build_object('active_legacy',0,'low_authority',6,'shadow_only',95,'disabled',49);
  update public.memory_import_runs set run_status='complete',completed_at=now(),imported_count=150,rejected_count=0,
    tier_statistics=v_tiers,validation_summary=jsonb_build_object('result','PASS','validated_count',150)
    where user_id=p_user_id and id=p_import_run_id and run_status='applying';
  insert into public.memory_operations(user_id,import_run_id,operation_type,idempotency_key,actor_type,policy_version)
    select user_id,id,'legacy_import_finalize',p_idempotency_key,'migration',policy_version from public.memory_import_runs
    where user_id=p_user_id and id=p_import_run_id returning id into v_op;
  perform public.xiaoc_memory_finish_operation(p_user_id,v_op,'success',null,v_ids,null,jsonb_build_object('tiers',v_tiers));
  return v_op;
end; $$;

create function public.xiaoc_memory_rollback_import_run(p_user_id text,p_import_run_id uuid,p_contract_digest text,p_idempotency_key text)
returns uuid language plpgsql security definer set search_path=public,extensions,pg_catalog as $$
declare v_op uuid; v_ids uuid[]; v_status text; v_policy text;
begin
  select run_status,policy_version into v_status,v_policy from public.memory_import_runs where user_id=p_user_id and id=p_import_run_id
    and classification_digest=p_contract_digest for update;
  if not found or v_status not in ('complete','failed','disabled') then raise exception 'same-user rollback-eligible run and contract required'; end if;
  select id into v_op from public.memory_operations where user_id=p_user_id and import_run_id=p_import_run_id
    and operation_type='legacy_import_rollback' and idempotency_key=p_idempotency_key and result_status='success';
  if v_op is not null then return v_op; end if;
  if v_status='disabled' then raise exception 'disabled run requires its original rollback idempotency key'; end if;
  select array_agg(memory_id order by memory_id) into v_ids from public.legacy_memory_map where user_id=p_user_id and import_run_id=p_import_run_id;
  if cardinality(v_ids)<>150
    or exists(select 1 from public.memory_items where user_id=p_user_id and id=any(v_ids)
      and (origin_system<>'ombre_legacy' or provenance_status<>'legacy_unverified'))
    or exists(select 1 from public.memory_provenance where user_id=p_user_id and memory_id=any(v_ids))
    or exists(select 1 from public.memory_pins where user_id=p_user_id and memory_id=any(v_ids))
    or exists(select 1 from public.memory_embeddings where user_id=p_user_id and memory_id=any(v_ids))
    or exists(select 1 from public.memory_relations where user_id=p_user_id and (from_memory_id=any(v_ids) or to_memory_id=any(v_ids))) then
    raise exception 'rollback blocked by target mismatch or downstream dependency';
  end if;
  insert into public.memory_operations(user_id,import_run_id,operation_type,idempotency_key,actor_type,policy_version,before_state)
    values(p_user_id,p_import_run_id,'legacy_import_rollback',p_idempotency_key,'migration',v_policy,
      (select jsonb_object_agg(retrieval_tier,n) from (select retrieval_tier,count(*) n from public.memory_items
        where user_id=p_user_id and id=any(v_ids) group by retrieval_tier) s)) returning id into v_op;
  update public.memory_items set retrieval_tier='disabled',authority_tier='none',revision=revision+1,updated_at=now()
    where user_id=p_user_id and id=any(v_ids) and (retrieval_tier<>'disabled' or authority_tier<>'none');
  update public.memory_import_runs set run_status='disabled',validation_summary=validation_summary||jsonb_build_object('rollback','PASS')
    where user_id=p_user_id and id=p_import_run_id and run_status=v_status;
  perform public.xiaoc_memory_finish_operation(p_user_id,v_op,'success',null,v_ids,null,jsonb_build_object('disabled_count',150));
  return v_op;
end; $$;

alter table public.memory_import_plan_items enable row level security;
revoke all on public.memory_import_plan_items from public,anon,authenticated;
revoke insert,update,delete on public.memory_import_plan_items from service_role;
grant select on public.memory_import_plan_items to service_role;

revoke all on function public.xiaoc_memory_create_import_run(text,text,text,text,text,text,integer,text,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.xiaoc_memory_start_import_run(text,uuid,text,text) from public,anon,authenticated;
revoke all on function public.xiaoc_memory_fail_import_run(text,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.xiaoc_memory_finalize_import_run(text,uuid,text,text) from public,anon,authenticated;
revoke all on function public.xiaoc_memory_rollback_import_run(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.xiaoc_memory_create_import_run(text,text,text,text,text,text,integer,text,text,jsonb,text) to service_role;
grant execute on function public.xiaoc_memory_start_import_run(text,uuid,text,text) to service_role;
grant execute on function public.xiaoc_memory_fail_import_run(text,uuid,text,text,text) to service_role;
grant execute on function public.xiaoc_memory_finalize_import_run(text,uuid,text,text) to service_role;
grant execute on function public.xiaoc_memory_rollback_import_run(text,uuid,text,text) to service_role;

comment on table public.memory_import_plan_items is 'Immutable M2D approved classification plan; contains identities and hashes, never Memory bodies.';

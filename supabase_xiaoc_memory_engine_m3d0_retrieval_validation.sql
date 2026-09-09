-- Manual validation for M3D0. Run only after the M3D0 migration.
-- All synthetic fixtures and checks are rolled back.

begin;

do $$
begin
  if not has_function_privilege('service_role', 'public.xiaoc_memory_retrieve_lexical_candidates(text,text,timestamptz,text[],integer)', 'EXECUTE') then
    raise exception 'ASSERTION FAILED: service_role lexical execute missing';
  end if;
  if not has_function_privilege('service_role', 'public.xiaoc_memory_retrieve_semantic_candidates(text,text,timestamptz,extensions.vector,text,text,text,text,integer,integer)', 'EXECUTE') then
    raise exception 'ASSERTION FAILED: service_role semantic execute missing';
  end if;
  if not has_function_privilege('service_role', 'public.xiaoc_memory_retrieve_candidate_relations(text,uuid[],integer)', 'EXECUTE') then
    raise exception 'ASSERTION FAILED: service_role relation execute missing';
  end if;
  if has_function_privilege('anon', 'public.xiaoc_memory_retrieve_lexical_candidates(text,text,timestamptz,text[],integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.xiaoc_memory_retrieve_lexical_candidates(text,text,timestamptz,text[],integer)', 'EXECUTE') then
    raise exception 'ASSERTION FAILED: client role can execute protected retrieval';
  end if;
  if has_table_privilege('service_role', 'public.memory_items', 'INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role', 'public.memory_embeddings', 'INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role', 'public.memory_relations', 'INSERT,UPDATE,DELETE') then
    raise exception 'ASSERTION FAILED: direct mutation privilege exists';
  end if;
end;
$$;

insert into public.memory_operations (
  id,user_id,operation_type,idempotency_key,actor_type,policy_version,result_status,affected_memory_ids,created_at,completed_at
) values
  ('30000000-0000-0000-0000-000000000001','__m3d0_a__','validation','m3d0-op-a','system','m3d0-validation','success','{}',now(),now());

insert into public.memory_items (
  id,user_id,canonical_content,content_hash,origin_system,memory_class,category,
  provenance_status,lifecycle_status,retrieval_tier,authority_tier,authority_policy_version,
  claim_key,importance,confidence,event_time,valid_from,valid_until,resolved_at,
  superseded_at,deleted_at,capture_policy_version,created_at,updated_at
) values
  ('30000000-0000-0000-0000-000000000010','__m3d0_a__','合成海岛记忆','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','xiaoc_native','observation','event','verified_user','active',null,'native_verified','m3d0',null,5,1,now(),null,null,null,null,null,'m3d0',now(),now()),
  ('30000000-0000-0000-0000-000000000011','__m3d0_b__','合成海岛记忆','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','xiaoc_native','observation','event','verified_user','active',null,'native_verified','m3d0',null,5,1,now(),null,null,null,null,null,'m3d0',now(),now()),
  ('30000000-0000-0000-0000-000000000012','__m3d0_a__','海岛 shadow','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','ombre_legacy','observation','event','legacy_unverified','active','shadow_only','none','m3d0',null,5,1,now(),null,null,null,null,null,'m3d0',now(),now()),
  ('30000000-0000-0000-0000-000000000013','__m3d0_a__','海岛 disabled','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','ombre_legacy','observation','event','legacy_unverified','active','disabled','none','m3d0',null,5,1,now(),null,null,null,null,null,'m3d0',now(),now()),
  ('30000000-0000-0000-0000-000000000014','__m3d0_a__','海岛 deleted','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','xiaoc_native','observation','event','verified_user','deleted',null,'native_verified','m3d0',null,5,1,now(),null,null,null,null,now(),'m3d0',now(),now()),
  ('30000000-0000-0000-0000-000000000015','__m3d0_a__','海岛 superseded','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','xiaoc_native','observation','event','verified_user','superseded',null,'native_verified','m3d0',null,5,1,now(),null,null,null,now(),null,'m3d0',now(),now()),
  ('30000000-0000-0000-0000-000000000016','__m3d0_a__','合成电影记忆','1111111111111111111111111111111111111111111111111111111111111111','xiaoc_native','observation','event','verified_user','active',null,'native_verified','m3d0',null,5,1,now(),null,null,null,null,null,'m3d0',now(),now()),
  ('30000000-0000-0000-0000-000000000017','__m3d0_a__','被关系替代的海岛记忆','2222222222222222222222222222222222222222222222222222222222222222','ombre_legacy','observation','event','legacy_unverified','active','low_authority','legacy_limited','m3d0',null,5,1,now(),null,null,null,null,null,'m3d0',now(),now()),
  ('30000000-0000-0000-0000-000000000018','__m3d0_a__','新的替代记忆','3333333333333333333333333333333333333333333333333333333333333333','xiaoc_native','observation','event','verified_user','active',null,'native_verified','m3d0',null,5,1,now(),null,null,null,null,null,'m3d0',now(),now()),
  ('30000000-0000-0000-0000-000000000019','__m3d0_a__','合成非活跃向量记忆','4444444444444444444444444444444444444444444444444444444444444444','xiaoc_native','observation','event','verified_user','active',null,'native_verified','m3d0',null,5,1,now(),null,null,null,null,null,'m3d0',now(),now());

insert into public.memory_embeddings (
  id,user_id,memory_id,provider,model,embedding_version,preprocessor_version,dimensions,content_hash,embedding,rollout_status
) values
  ('30000000-0000-0000-0000-000000000020','__m3d0_a__','30000000-0000-0000-0000-000000000010','synthetic','model-a','v1','content-v1',3,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','[1,0,0]'::extensions.vector,'active'),
  ('30000000-0000-0000-0000-000000000021','__m3d0_b__','30000000-0000-0000-0000-000000000011','synthetic','model-a','v1','content-v1',3,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','[1,0,0]'::extensions.vector,'active'),
  ('30000000-0000-0000-0000-000000000022','__m3d0_a__','30000000-0000-0000-0000-000000000016','synthetic','model-b','v1','content-v1',3,'1111111111111111111111111111111111111111111111111111111111111111','[1,0,0]'::extensions.vector,'active'),
  ('30000000-0000-0000-0000-000000000023','__m3d0_a__','30000000-0000-0000-0000-000000000019','synthetic','model-a','v1','content-v1',3,'4444444444444444444444444444444444444444444444444444444444444444','[1,0,0]'::extensions.vector,'shadow');

insert into public.memory_relations (
  id,user_id,from_memory_id,to_memory_id,relation_type,operation_id
) values (
  '30000000-0000-0000-0000-000000000030','__m3d0_a__',
  '30000000-0000-0000-0000-000000000018','30000000-0000-0000-0000-000000000017',
  'supersedes','30000000-0000-0000-0000-000000000001'
);

set local role service_role;

do $$
declare v_count integer;
begin
  select count(*) into v_count from public.xiaoc_memory_retrieve_lexical_candidates(
    '__m3d0_a__','normal_current',now(),array['海岛'],24
  );
  if v_count <> 2 then raise exception 'ASSERTION FAILED: lexical scope/eligibility expected 2 got %', v_count; end if;

  select count(*) into v_count from public.xiaoc_memory_retrieve_lexical_candidates(
    '__m3d0_a__','normal_current',now(),array['海岛'],24
  ) where memory_id in (
    '30000000-0000-0000-0000-000000000012',
    '30000000-0000-0000-0000-000000000013',
    '30000000-0000-0000-0000-000000000014',
    '30000000-0000-0000-0000-000000000015'
  );
  if v_count <> 0 then raise exception 'ASSERTION FAILED: forbidden tier/lifecycle row leaked'; end if;

  select count(*) into v_count from public.xiaoc_memory_retrieve_lexical_candidates(
    '__m3d0_b__','normal_current',now(),array['海岛'],24
  );
  if v_count <> 1 then raise exception 'ASSERTION FAILED: cross-user lexical isolation'; end if;

  select count(*) into v_count from public.xiaoc_memory_retrieve_semantic_candidates(
    '__m3d0_a__','normal_current',now(),'[1,0,0]'::extensions.vector,
    'synthetic','model-a','v1','content-v1',3,24
  );
  if v_count <> 1 then raise exception 'ASSERTION FAILED: semantic eligible-before-vector expected 1 got %', v_count; end if;

  select count(*) into v_count from public.xiaoc_memory_retrieve_semantic_candidates(
    '__m3d0_b__','normal_current',now(),'[1,0,0]'::extensions.vector,
    'synthetic','model-a','v1','content-v1',3,24
  ) where memory_id = '30000000-0000-0000-0000-000000000011' and user_id = '__m3d0_b__';
  if v_count <> 1 then raise exception 'ASSERTION FAILED: cross-user semantic isolation'; end if;

  select count(*) into v_count from public.xiaoc_memory_retrieve_semantic_candidates(
    '__m3d0_a__','normal_current',now(),'[1,0,0]'::extensions.vector,
    'synthetic','missing-model','v1','content-v1',3,24
  );
  if v_count <> 0 then raise exception 'ASSERTION FAILED: incompatible/zero embedding should return zero'; end if;

  select count(*) into v_count from public.xiaoc_memory_retrieve_candidate_relations(
    '__m3d0_a__',array['30000000-0000-0000-0000-000000000017']::uuid[],128
  ) where from_memory_id = '30000000-0000-0000-0000-000000000018';
  if v_count <> 1 then raise exception 'ASSERTION FAILED: replacement outside pool relation missing'; end if;

  select count(*) into v_count from public.xiaoc_memory_retrieve_candidate_relations(
    '__m3d0_b__',array['30000000-0000-0000-0000-000000000017']::uuid[],128
  );
  if v_count <> 0 then raise exception 'ASSERTION FAILED: cross-user relation leaked'; end if;

  begin
    perform * from public.xiaoc_memory_retrieve_lexical_candidates('__m3d0_a__','invalid',now(),array['海岛'],24);
    raise exception 'ASSERTION FAILED: invalid mode accepted';
  exception when others then
    if position('RETRIEVAL_MODE_INVALID' in sqlerrm) = 0 then raise; end if;
  end;
  begin
    perform * from public.xiaoc_memory_retrieve_lexical_candidates('__m3d0_a__','normal_current',now(),array['海岛'],33);
    raise exception 'ASSERTION FAILED: oversized lexical limit accepted';
  exception when others then
    if position('LEXICAL_LIMIT_INVALID' in sqlerrm) = 0 then raise; end if;
  end;
  begin
    perform * from public.xiaoc_memory_retrieve_semantic_candidates(
      '__m3d0_a__','normal_current',now(),'[1,0]'::extensions.vector,'synthetic','model-a','v1','content-v1',3,24
    );
    raise exception 'ASSERTION FAILED: wrong vector dimension accepted';
  exception when others then
    if position('SEMANTIC_VECTOR_DIMENSION_INVALID' in sqlerrm) = 0 then raise; end if;
  end;
end;
$$;

reset role;

rollback;

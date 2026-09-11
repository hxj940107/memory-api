-- Exact M2A/M2C.1 ACL restoration for the objects changed by M2C.3.
-- Run only during the declared rollback window after pausing verification traffic.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_advisory_xact_lock(hashtextextended('xiaoc:multi-user:m2c3:grant-containment', 0));

grant execute on function public.check_pending_moments_for_xiaoc() to public, anon, authenticated, service_role;
grant execute on function public.xiaoc_memory_guard_append_only() to public, anon, authenticated, service_role;
grant execute on function public.xiaoc_memory_guard_embedding_transition() to public, anon, authenticated, service_role;
grant execute on function public.xiaoc_memory_guard_import_run() to public, anon, authenticated, service_role;
grant execute on function public.xiaoc_memory_guard_item_immutable() to public, anon, authenticated, service_role;
grant execute on function public.xiaoc_memory_guard_operation_transition() to public, anon, authenticated, service_role;

-- In the canonical M2A baseline these four service lanes were inherited from
-- PUBLIC, not stored as explicit service_role ACL entries.  The forward adds
-- one explicit writer grant and the old rollback added three more; remove all
-- four explicit entries after PUBLIC access has been restored.
revoke execute on function public.check_pending_moments_for_xiaoc() from service_role;
revoke execute on function public.xiaoc_memory_guard_append_only() from service_role;
revoke execute on function public.xiaoc_memory_guard_embedding_transition() from service_role;
revoke execute on function public.xiaoc_memory_guard_import_run() from service_role;

grant all privileges on table
  public.conversation_summary,
  public.conversations,
  public.memories,
  public.messages,
  public.user_state
to anon, authenticated, service_role;

grant truncate, references, trigger, maintain on table
  public.album_assets,
  public.conversation_summary,
  public.conversations,
  public.diary_entries,
  public.memories,
  public.messages,
  public.moment_candidates,
  public.moment_check_audit,
  public.moment_comments,
  public.moment_entries,
  public.moment_interaction_state,
  public.moment_xiaoc_activity,
  public.shared_contexts,
  public.treehole_entries,
  public.user_state,
  public.xiaoc_proactive_tasks
to anon, authenticated, service_role;

grant references, trigger, maintain on table
  public.background_worker_run_audit,
  public.treehole_execution_audit
to anon, authenticated, service_role;

grant all privileges on sequence
  public.album_assets_id_seq,
  public.background_worker_run_audit_id_seq,
  public.conversation_summary_id_seq,
  public.moment_candidates_id_seq,
  public.moment_check_audit_id_seq,
  public.moment_xiaoc_activity_id_seq,
  public.treehole_execution_audit_id_seq,
  public.xiaoc_proactive_tasks_id_seq
to anon, authenticated, service_role;

alter default privileges for role postgres in schema public grant all privileges on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all privileges on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;

do $m2c3_rollback_postflight$
declare
  v_check integer;
  v_guards integer;
  v_core integer;
  v_high_risk integer;
  v_defaults integer;
  v_sequences integer;
  v_redundant_explicit integer;
begin
  select count(*) into v_check
  from unnest(array['anon','authenticated']) r
  where has_function_privilege(r, 'public.check_pending_moments_for_xiaoc()', 'EXECUTE');

  select count(*) into v_guards
  from unnest(array['anon','authenticated']) r
  cross join unnest(array[
    'public.xiaoc_memory_guard_append_only()',
    'public.xiaoc_memory_guard_embedding_transition()',
    'public.xiaoc_memory_guard_import_run()',
    'public.xiaoc_memory_guard_item_immutable()',
    'public.xiaoc_memory_guard_operation_transition()'
  ]) f
  where has_function_privilege(r, f, 'EXECUTE');

  select count(*) into v_core
  from unnest(array['anon','authenticated']) r
  cross join unnest(array[
    'public.conversation_summary','public.conversations','public.memories','public.messages','public.user_state'
  ]) t
  cross join unnest(array[
    'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
  ]) p
  where has_table_privilege(r, t, p);

  select count(*) into v_high_risk
  from unnest(array['anon','authenticated']) r
  cross join (
    select table_name, privilege_name
    from unnest(array[
      'public.album_assets','public.conversation_summary','public.conversations',
      'public.diary_entries','public.memories','public.messages','public.moment_candidates',
      'public.moment_check_audit','public.moment_comments','public.moment_entries',
      'public.moment_interaction_state','public.moment_xiaoc_activity','public.shared_contexts',
      'public.treehole_entries','public.user_state','public.xiaoc_proactive_tasks'
    ]) table_name
    cross join unnest(array['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) privilege_name
    union all
    select table_name, privilege_name
    from unnest(array[
      'public.background_worker_run_audit','public.treehole_execution_audit'
    ]) table_name
    cross join unnest(array['REFERENCES','TRIGGER','MAINTAIN']) privilege_name
  ) target
  where has_table_privilege(r, target.table_name, target.privilege_name);

  select count(*) into v_defaults
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) x
  left join pg_roles grantee on grantee.oid = x.grantee
  join pg_roles owner_role on owner_role.oid = d.defaclrole
  where n.nspname = 'public' and owner_role.rolname = 'postgres'
    and ((grantee.rolname in ('anon','authenticated') and d.defaclobjtype in ('r','S','f'))
      or (x.grantee = 0 and d.defaclobjtype = 'f'));

  select count(*) into v_sequences
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join unnest(array['anon','authenticated']) r
  cross join unnest(array['SELECT','USAGE','UPDATE']) p
  where n.nspname = 'public' and c.relkind = 'S'
    and has_sequence_privilege(r, c.oid, p);

  select count(*) into v_redundant_explicit
  from unnest(array[
    'public.check_pending_moments_for_xiaoc()',
    'public.xiaoc_memory_guard_append_only()',
    'public.xiaoc_memory_guard_embedding_transition()',
    'public.xiaoc_memory_guard_import_run()'
  ]) function_name
  join pg_proc p on p.oid = function_name::regprocedure
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
  join pg_roles grantee on grantee.oid = x.grantee
  where grantee.rolname = 'service_role'
    and x.privilege_type = 'EXECUTE';

  if v_check <> 2 or v_guards <> 10 or v_core <> 80
    or v_high_risk <> 140 or v_defaults <> 24 or v_sequences <> 48
    or v_redundant_explicit <> 0 then
    raise exception 'M2C3_ROLLBACK_NOT_CANONICAL: check=%, guards=%, core=%, high_risk=%, defaults=%, sequences=%, redundant_service_functions=%',
      v_check, v_guards, v_core, v_high_risk, v_defaults, v_sequences, v_redundant_explicit;
  end if;

  if not has_function_privilege('service_role', 'public.check_pending_moments_for_xiaoc()', 'EXECUTE') then
    raise exception 'M2C3_ROLLBACK_SERVICE_LANE_MISSING';
  end if;

  if exists (
    select 1
    from unnest(array[
      'public.conversation_summary','public.conversations','public.memories','public.messages','public.user_state'
    ]) t
    cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
    where not has_table_privilege('service_role', t, p)
  ) or exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='S'
      and not has_sequence_privilege('service_role', c.oid, 'USAGE')
  ) then
    raise exception 'M2C3_ROLLBACK_SERVICE_DATA_LANE_MISSING';
  end if;
end
$m2c3_rollback_postflight$;

commit;

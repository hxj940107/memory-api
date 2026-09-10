-- Multi-user M2C.3: narrow, transactional grant containment only.
-- PREPARED ONLY. Do not run without the separately approved Production apply.
-- No schema, data, RLS policy, API, Storage policy, or Ombre change is included.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_advisory_xact_lock(hashtextextended('xiaoc:multi-user:m2c3:grant-containment', 0));

do $m2c3_preflight$
declare
  v_check_grants integer;
  v_guard_grants integer;
  v_core_grants integer;
  v_high_risk_grants integer;
  v_sequence_grants integer;
  v_default_acl_grants integer;
  v_before boolean;
  v_after boolean;
begin
  if to_regprocedure('public.check_pending_moments_for_xiaoc()') is null then
    raise exception 'M2C3_EXPECTED_FUNCTION_MISSING';
  end if;

  if exists (
    select 1
    from unnest(array[
      'public.conversation_summary',
      'public.conversations',
      'public.memories',
      'public.messages',
      'public.user_state'
    ]) as expected(name)
    where to_regclass(expected.name) is null
  ) then
    raise exception 'M2C3_EXPECTED_CORE_TABLE_MISSING';
  end if;

  select count(*) into v_check_grants
  from unnest(array['anon', 'authenticated']) as role_name
  where has_function_privilege(role_name, 'public.check_pending_moments_for_xiaoc()', 'EXECUTE');

  select count(*) into v_guard_grants
  from unnest(array['anon', 'authenticated']) as role_name
  cross join unnest(array[
    'public.xiaoc_memory_guard_append_only()',
    'public.xiaoc_memory_guard_embedding_transition()',
    'public.xiaoc_memory_guard_import_run()',
    'public.xiaoc_memory_guard_item_immutable()',
    'public.xiaoc_memory_guard_operation_transition()'
  ]) as function_name
  where has_function_privilege(role_name, function_name, 'EXECUTE');

  select count(*) into v_core_grants
  from unnest(array['anon', 'authenticated']) as role_name
  cross join unnest(array[
    'public.conversation_summary',
    'public.conversations',
    'public.memories',
    'public.messages',
    'public.user_state'
  ]) as table_name
  cross join unnest(array[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]) as privilege_name
  where has_table_privilege(role_name, table_name, privilege_name);

  select count(*) into v_high_risk_grants
  from unnest(array['anon', 'authenticated']) as role_name
  cross join (
    values
      ('public.album_assets', 'REFERENCES'), ('public.album_assets', 'TRIGGER'), ('public.album_assets', 'TRUNCATE'),
      ('public.background_worker_run_audit', 'REFERENCES'), ('public.background_worker_run_audit', 'TRIGGER'),
      ('public.conversation_summary', 'REFERENCES'), ('public.conversation_summary', 'TRIGGER'), ('public.conversation_summary', 'TRUNCATE'),
      ('public.conversations', 'REFERENCES'), ('public.conversations', 'TRIGGER'), ('public.conversations', 'TRUNCATE'),
      ('public.diary_entries', 'REFERENCES'), ('public.diary_entries', 'TRIGGER'), ('public.diary_entries', 'TRUNCATE'),
      ('public.memories', 'REFERENCES'), ('public.memories', 'TRIGGER'), ('public.memories', 'TRUNCATE'),
      ('public.messages', 'REFERENCES'), ('public.messages', 'TRIGGER'), ('public.messages', 'TRUNCATE'),
      ('public.moment_candidates', 'REFERENCES'), ('public.moment_candidates', 'TRIGGER'), ('public.moment_candidates', 'TRUNCATE'),
      ('public.moment_check_audit', 'REFERENCES'), ('public.moment_check_audit', 'TRIGGER'), ('public.moment_check_audit', 'TRUNCATE'),
      ('public.moment_comments', 'REFERENCES'), ('public.moment_comments', 'TRIGGER'), ('public.moment_comments', 'TRUNCATE'),
      ('public.moment_entries', 'REFERENCES'), ('public.moment_entries', 'TRIGGER'), ('public.moment_entries', 'TRUNCATE'),
      ('public.moment_interaction_state', 'REFERENCES'), ('public.moment_interaction_state', 'TRIGGER'), ('public.moment_interaction_state', 'TRUNCATE'),
      ('public.moment_xiaoc_activity', 'REFERENCES'), ('public.moment_xiaoc_activity', 'TRIGGER'), ('public.moment_xiaoc_activity', 'TRUNCATE'),
      ('public.shared_contexts', 'REFERENCES'), ('public.shared_contexts', 'TRIGGER'), ('public.shared_contexts', 'TRUNCATE'),
      ('public.treehole_entries', 'REFERENCES'), ('public.treehole_entries', 'TRIGGER'), ('public.treehole_entries', 'TRUNCATE'),
      ('public.treehole_execution_audit', 'REFERENCES'), ('public.treehole_execution_audit', 'TRIGGER'),
      ('public.user_state', 'REFERENCES'), ('public.user_state', 'TRIGGER'), ('public.user_state', 'TRUNCATE'),
      ('public.xiaoc_proactive_tasks', 'REFERENCES'), ('public.xiaoc_proactive_tasks', 'TRIGGER'), ('public.xiaoc_proactive_tasks', 'TRUNCATE')
  ) as target(table_name, privilege_name)
  where has_table_privilege(role_name, target.table_name, target.privilege_name);

  select count(*) into v_sequence_grants
  from unnest(array['anon', 'authenticated']) as role_name
  cross join unnest(array[
    'public.album_assets_id_seq',
    'public.background_worker_run_audit_id_seq',
    'public.conversation_summary_id_seq',
    'public.moment_candidates_id_seq',
    'public.moment_check_audit_id_seq',
    'public.moment_xiaoc_activity_id_seq',
    'public.treehole_execution_audit_id_seq',
    'public.xiaoc_proactive_tasks_id_seq'
  ]) as sequence_name
  cross join unnest(array['SELECT', 'USAGE', 'UPDATE']) as privilege_name
  where has_sequence_privilege(role_name, sequence_name, privilege_name);

  select count(*) into v_default_acl_grants
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) x
  left join pg_roles grantee on grantee.oid = x.grantee
  join pg_roles owner_role on owner_role.oid = d.defaclrole
  where n.nspname = 'public'
    and owner_role.rolname = 'postgres'
    and (
      (grantee.rolname in ('anon', 'authenticated') and d.defaclobjtype in ('r', 'S', 'f'))
      or (x.grantee = 0 and d.defaclobjtype = 'f')
    );

  v_before := v_check_grants = 2
    and v_guard_grants = 10
    and v_core_grants = 70
    and v_high_risk_grants = 104
    and v_sequence_grants = 48
    and v_default_acl_grants = 22;

  v_after := v_check_grants = 0
    and v_guard_grants = 0
    and v_core_grants = 0
    and v_high_risk_grants = 0
    and v_sequence_grants = 0
    and v_default_acl_grants = 0;

  if not v_before and not v_after then
    raise exception 'M2C3_PARTIAL_OR_DRIFTED_ACL_STATE: check=%, guards=%, core=%, high_risk=%, sequences=%, defaults=%',
      v_check_grants, v_guard_grants, v_core_grants, v_high_risk_grants, v_sequence_grants, v_default_acl_grants;
  end if;

  if not has_function_privilege('service_role', 'public.check_pending_moments_for_xiaoc()', 'EXECUTE') then
    raise exception 'M2C3_SERVICE_EXECUTE_BASELINE_MISSING';
  end if;
end
$m2c3_preflight$;

-- The only exposed SECURITY DEFINER writer. Keep the existing service lane.
revoke all on function public.check_pending_moments_for_xiaoc() from public, anon, authenticated;
grant execute on function public.check_pending_moments_for_xiaoc() to service_role;

-- Trigger invocation does not require ordinary callers to hold direct EXECUTE.
revoke all on function public.xiaoc_memory_guard_append_only() from public, anon, authenticated;
revoke all on function public.xiaoc_memory_guard_embedding_transition() from public, anon, authenticated;
revoke all on function public.xiaoc_memory_guard_import_run() from public, anon, authenticated;
revoke all on function public.xiaoc_memory_guard_item_immutable() from public, anon, authenticated;
revoke all on function public.xiaoc_memory_guard_operation_transition() from public, anon, authenticated;

-- RLS is OFF on these five tables. No current Private App caller uses anon/authenticated.
revoke all privileges on table
  public.conversation_summary,
  public.conversations,
  public.memories,
  public.messages,
  public.user_state
from anon, authenticated;

-- These privileges are not row-level CRUD and must not remain on business tables.
revoke truncate, references, trigger on table
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
from anon, authenticated;

revoke references, trigger on table
  public.background_worker_run_audit,
  public.treehole_execution_audit
from anon, authenticated;

-- Sequence access bypasses table RLS and can leak or advance global counters.
revoke all privileges on sequence
  public.album_assets_id_seq,
  public.background_worker_run_audit_id_seq,
  public.conversation_summary_id_seq,
  public.moment_candidates_id_seq,
  public.moment_check_audit_id_seq,
  public.moment_xiaoc_activity_id_seq,
  public.treehole_execution_audit_id_seq,
  public.xiaoc_proactive_tasks_id_seq
from anon, authenticated;

-- Future public objects start private; later user-facing grants must be explicit.
alter default privileges for role postgres in schema public revoke all privileges on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all privileges on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

commit;

-- XiaoC observability permission-hardening validation.
-- Metadata-only: no synthetic or business rows are written.

begin read only;

do $validation$
declare
  v_cleanup regprocedure := to_regprocedure('public.cleanup_xiaoc_observability_audits(integer)');
begin
  if to_regclass('public.treehole_execution_audit') is null
    or to_regclass('public.background_worker_run_audit') is null then
    raise exception 'OBSERVABILITY_PERMISSION_VALIDATION_FAILED: audit table missing';
  end if;

  if not has_table_privilege('service_role', 'public.treehole_execution_audit', 'SELECT')
    or not has_table_privilege('service_role', 'public.treehole_execution_audit', 'INSERT')
    or not has_table_privilege('service_role', 'public.background_worker_run_audit', 'SELECT')
    or not has_table_privilege('service_role', 'public.background_worker_run_audit', 'INSERT') then
    raise exception 'OBSERVABILITY_PERMISSION_VALIDATION_FAILED: required service-role table privilege missing';
  end if;

  if has_table_privilege('service_role', 'public.treehole_execution_audit', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_table_privilege('service_role', 'public.background_worker_run_audit', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
    raise exception 'OBSERVABILITY_PERMISSION_VALIDATION_FAILED: service role retains mutation privilege';
  end if;

  if has_table_privilege('anon', 'public.treehole_execution_audit', 'INSERT,UPDATE,DELETE,TRUNCATE')
    or has_table_privilege('anon', 'public.background_worker_run_audit', 'INSERT,UPDATE,DELETE,TRUNCATE')
    or has_table_privilege('authenticated', 'public.treehole_execution_audit', 'INSERT,UPDATE,DELETE,TRUNCATE')
    or has_table_privilege('authenticated', 'public.background_worker_run_audit', 'INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'OBSERVABILITY_PERMISSION_VALIDATION_FAILED: client mutation privilege exists';
  end if;

  if not has_sequence_privilege('service_role', 'public.treehole_execution_audit_id_seq', 'USAGE')
    or not has_sequence_privilege('service_role', 'public.background_worker_run_audit_id_seq', 'USAGE') then
    raise exception 'OBSERVABILITY_PERMISSION_VALIDATION_FAILED: identity sequence unavailable';
  end if;

  if v_cleanup is null then
    raise exception 'OBSERVABILITY_PERMISSION_VALIDATION_FAILED: cleanup function missing';
  end if;
  if not (
    select p.prosecdef
      and r.rolname = 'postgres'
      and coalesce(array_to_string(p.proconfig, ','), '') = 'search_path=pg_catalog, public'
    from pg_proc p
    join pg_roles r on r.oid = p.proowner
    where p.oid = v_cleanup
  ) then
    raise exception 'OBSERVABILITY_PERMISSION_VALIDATION_FAILED: cleanup definer boundary is unsafe';
  end if;
  if not has_function_privilege('service_role', v_cleanup, 'EXECUTE')
    or has_function_privilege('anon', v_cleanup, 'EXECUTE')
    or has_function_privilege('authenticated', v_cleanup, 'EXECUTE') then
    raise exception 'OBSERVABILITY_PERMISSION_VALIDATION_FAILED: cleanup execute grants are incorrect';
  end if;

  if position('p_retention_days integer DEFAULT 60' in pg_get_functiondef(v_cleanup)) = 0
    or position('p_retention_days < 30 or p_retention_days > 365' in pg_get_functiondef(v_cleanup)) = 0
    or position('delete from public.treehole_execution_audit' in lower(pg_get_functiondef(v_cleanup))) = 0
    or position('delete from public.background_worker_run_audit' in lower(pg_get_functiondef(v_cleanup))) = 0 then
    raise exception 'OBSERVABILITY_PERMISSION_VALIDATION_FAILED: cleanup semantics changed';
  end if;
end
$validation$;

select 'OBSERVABILITY_PERMISSION_HARDENING_VALIDATION_PASS' as validation_result;

rollback;


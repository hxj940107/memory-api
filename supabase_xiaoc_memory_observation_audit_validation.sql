-- Transactional synthetic validation. Never retains rows.
begin;

do $$
declare
  v_table regclass := to_regclass('public.xiaoc_memory_observation_audit');
  v_cleanup regprocedure := to_regprocedure('public.cleanup_xiaoc_observability_audits(integer)');
begin
  if v_table is null or v_cleanup is null then raise exception 'observation audit objects missing'; end if;
  if has_table_privilege('anon', v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    or has_table_privilege('authenticated', v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'client audit privileges are too broad';
  end if;
  if not has_table_privilege('service_role', v_table, 'SELECT')
    or not has_table_privilege('service_role', v_table, 'INSERT')
    or has_table_privilege('service_role', v_table, 'UPDATE,DELETE,TRUNCATE') then
    raise exception 'service audit privileges invalid';
  end if;
  if position('delete from public.xiaoc_memory_observation_audit' in lower(pg_get_functiondef(v_cleanup))) = 0 then
    raise exception 'observation retention cleanup missing';
  end if;
end;
$$;

set local role service_role;

insert into public.xiaoc_memory_observation_audit (
  user_id, occurred_at, event_kind, environment, policy_version, correlation_id_hash,
  retrieval_mode, eligible_opportunity, sampled, attempted, outcome,
  candidate_count, eligible_count, selected_count, total_latency_ms
) values (
  '__xiaoc_memory_audit_validation__', now(), 'retrieval_shadow', 'validation',
  'xiaoc-memory-observation-audit-v1', repeat('a',64), 'normal_current',
  true, true, true, 'empty', 2, 1, 0, 25
), (
  '__xiaoc_memory_audit_validation__', now(), 'native_capture_shadow', 'validation',
  'xiaoc-memory-observation-audit-v1', repeat('b',64), null,
  true, true, true, 'success', 0, 0, 0, 10
);

do $$
begin
  if (select count(*) from public.xiaoc_memory_observation_audit
      where user_id='__xiaoc_memory_audit_validation__') <> 2 then
    raise exception 'synthetic observation audit rows missing';
  end if;
end;
$$;

rollback;

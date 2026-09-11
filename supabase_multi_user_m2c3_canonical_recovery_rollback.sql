-- Compensating rollback for canonical recovery only. Restores the four
-- redundant explicit ACL entries; it does not run M2C.3 forward or rollback.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_advisory_xact_lock(hashtextextended('xiaoc:multi-user:m2c3:canonical-recovery', 0));

do $m2c3_canonical_recovery_rollback_preflight$
declare
  v_explicit integer;
  v_public integer;
  v_service_effective integer;
begin
  with targets(signature) as (values
    ('public.check_pending_moments_for_xiaoc()'),
    ('public.xiaoc_memory_guard_append_only()'),
    ('public.xiaoc_memory_guard_embedding_transition()'),
    ('public.xiaoc_memory_guard_import_run()')
  ), acl as (
    select x.grantee, grantee.rolname, x.privilege_type
    from targets join pg_proc p on p.oid=targets.signature::regprocedure
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) x
    left join pg_roles grantee on grantee.oid=x.grantee
  )
  select
    count(*) filter (where rolname='service_role' and privilege_type='EXECUTE'),
    count(*) filter (where grantee=0 and privilege_type='EXECUTE')
  into v_explicit,v_public from acl;

  select count(*) into v_service_effective
  from unnest(array[
    'public.check_pending_moments_for_xiaoc()',
    'public.xiaoc_memory_guard_append_only()',
    'public.xiaoc_memory_guard_embedding_transition()',
    'public.xiaoc_memory_guard_import_run()'
  ]) signature
  where has_function_privilege('service_role',signature,'EXECUTE');

  if v_explicit<>0 or v_public<>4 or v_service_effective<>4 then
    raise exception 'M2C3_CANONICAL_RECOVERY_ROLLBACK_PREFLIGHT_FAILED';
  end if;
end
$m2c3_canonical_recovery_rollback_preflight$;

grant execute on function public.check_pending_moments_for_xiaoc() to service_role;
grant execute on function public.xiaoc_memory_guard_append_only() to service_role;
grant execute on function public.xiaoc_memory_guard_embedding_transition() to service_role;
grant execute on function public.xiaoc_memory_guard_import_run() to service_role;

do $m2c3_canonical_recovery_rollback_postflight$
declare
  v_explicit integer;
begin
  select count(*) into v_explicit
  from unnest(array[
    'public.check_pending_moments_for_xiaoc()',
    'public.xiaoc_memory_guard_append_only()',
    'public.xiaoc_memory_guard_embedding_transition()',
    'public.xiaoc_memory_guard_import_run()'
  ]) signature
  join pg_proc p on p.oid=signature::regprocedure
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) x
  join pg_roles grantee on grantee.oid=x.grantee
  where grantee.rolname='service_role' and x.privilege_type='EXECUTE';

  if v_explicit<>4 then
    raise exception 'M2C3_CANONICAL_RECOVERY_ROLLBACK_POSTFLIGHT_FAILED: explicit=%',v_explicit;
  end if;
end
$m2c3_canonical_recovery_rollback_postflight$;

commit;

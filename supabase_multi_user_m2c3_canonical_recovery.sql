-- M2C.3 canonical recovery: remove only four redundant explicit service_role
-- EXECUTE ACL entries. PREPARED ONLY; do not run without separate approval.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_advisory_xact_lock(hashtextextended('xiaoc:multi-user:m2c3:canonical-recovery', 0));

do $m2c3_canonical_recovery_preflight$
declare
  v_explicit integer;
  v_public integer;
  v_service_effective integer;
  v_check integer;
  v_guards integer;
  v_core integer;
  v_high_risk integer;
  v_defaults integer;
  v_sequences integer;
begin
  with targets(signature) as (values
    ('public.check_pending_moments_for_xiaoc()'),
    ('public.xiaoc_memory_guard_append_only()'),
    ('public.xiaoc_memory_guard_embedding_transition()'),
    ('public.xiaoc_memory_guard_import_run()')
  ), acl as (
    select targets.signature, x.grantee, grantee.rolname, x.privilege_type
    from targets
    join pg_proc p on p.oid=targets.signature::regprocedure
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) x
    left join pg_roles grantee on grantee.oid=x.grantee
  )
  select
    count(*) filter (where rolname='service_role' and privilege_type='EXECUTE'),
    count(*) filter (where grantee=0 and privilege_type='EXECUTE')
  into v_explicit, v_public
  from acl;

  select count(*) into v_service_effective
  from unnest(array[
    'public.check_pending_moments_for_xiaoc()',
    'public.xiaoc_memory_guard_append_only()',
    'public.xiaoc_memory_guard_embedding_transition()',
    'public.xiaoc_memory_guard_import_run()'
  ]) signature
  where has_function_privilege('service_role',signature,'EXECUTE');

  select count(*) into v_check
  from unnest(array['anon','authenticated']) r
  where has_function_privilege(r,'public.check_pending_moments_for_xiaoc()','EXECUTE');

  select count(*) into v_guards
  from unnest(array['anon','authenticated']) r
  cross join unnest(array[
    'public.xiaoc_memory_guard_append_only()',
    'public.xiaoc_memory_guard_embedding_transition()',
    'public.xiaoc_memory_guard_import_run()',
    'public.xiaoc_memory_guard_item_immutable()',
    'public.xiaoc_memory_guard_operation_transition()'
  ]) signature
  where has_function_privilege(r,signature,'EXECUTE');

  select count(*) into v_core
  from unnest(array['anon','authenticated']) r
  cross join unnest(array[
    'public.conversation_summary','public.conversations','public.memories','public.messages','public.user_state'
  ]) object_name
  cross join unnest(array[
    'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
  ]) privilege_name
  where has_table_privilege(r,object_name,privilege_name);

  select count(*) into v_high_risk
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  cross join unnest(array['anon','authenticated']) r
  cross join unnest(array['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) privilege_name
  where n.nspname='public' and c.relkind in ('r','p')
    and has_table_privilege(r,c.oid,privilege_name);

  select count(*) into v_defaults
  from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) x
  left join pg_roles grantee on grantee.oid=x.grantee
  join pg_roles owner_role on owner_role.oid=d.defaclrole
  where n.nspname='public' and owner_role.rolname='postgres'
    and ((grantee.rolname in ('anon','authenticated') and d.defaclobjtype in ('r','S','f'))
      or (x.grantee=0 and d.defaclobjtype='f'));

  select count(*) into v_sequences
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  cross join unnest(array['anon','authenticated']) r
  cross join unnest(array['SELECT','USAGE','UPDATE']) privilege_name
  where n.nspname='public' and c.relkind='S'
    and has_sequence_privilege(r,c.oid,privilege_name);

  if v_explicit<>4 or v_public<>4 or v_service_effective<>4
    or v_check<>2 or v_guards<>10 or v_core<>80 or v_high_risk<>140
    or v_defaults<>24 or v_sequences<>48 then
    raise exception 'M2C3_CANONICAL_RECOVERY_PREFLIGHT_FAILED: explicit=%, public=%, service=%, check=%, guards=%, core=%, high_risk=%, defaults=%, sequences=%',
      v_explicit,v_public,v_service_effective,v_check,v_guards,v_core,v_high_risk,v_defaults,v_sequences;
  end if;
end
$m2c3_canonical_recovery_preflight$;

revoke execute on function public.check_pending_moments_for_xiaoc() from service_role;
revoke execute on function public.xiaoc_memory_guard_append_only() from service_role;
revoke execute on function public.xiaoc_memory_guard_embedding_transition() from service_role;
revoke execute on function public.xiaoc_memory_guard_import_run() from service_role;

do $m2c3_canonical_recovery_postflight$
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
    from targets
    join pg_proc p on p.oid=targets.signature::regprocedure
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) x
    left join pg_roles grantee on grantee.oid=x.grantee
  )
  select
    count(*) filter (where rolname='service_role' and privilege_type='EXECUTE'),
    count(*) filter (where grantee=0 and privilege_type='EXECUTE')
  into v_explicit, v_public
  from acl;

  select count(*) into v_service_effective
  from unnest(array[
    'public.check_pending_moments_for_xiaoc()',
    'public.xiaoc_memory_guard_append_only()',
    'public.xiaoc_memory_guard_embedding_transition()',
    'public.xiaoc_memory_guard_import_run()'
  ]) signature
  where has_function_privilege('service_role',signature,'EXECUTE');

  if v_explicit<>0 or v_public<>4 or v_service_effective<>4 then
    raise exception 'M2C3_CANONICAL_RECOVERY_POSTFLIGHT_FAILED: explicit=%, public=%, service=%',
      v_explicit,v_public,v_service_effective;
  end if;
end
$m2c3_canonical_recovery_postflight$;

commit;

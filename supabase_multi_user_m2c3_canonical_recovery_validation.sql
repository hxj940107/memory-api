-- Read-only validation after M2C.3 canonical recovery.

begin transaction read only;

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
select 'no redundant explicit service EXECUTE' as check_name,
       count(*) filter (where rolname='service_role' and privilege_type='EXECUTE')=0 as pass
from acl
union all
select 'PUBLIC EXECUTE retained on all four',
       count(*) filter (where grantee=0 and privilege_type='EXECUTE')=4
from acl
union all
select 'service effective EXECUTE retained on all four',
       count(*)=4
from targets
where has_function_privilege('service_role',signature,'EXECUTE')
union all
select 'ordinary function baseline is 12',
       (select count(*) from unnest(array['anon','authenticated']) r
        where has_function_privilege(r,'public.check_pending_moments_for_xiaoc()','EXECUTE'))
       +
       (select count(*) from unnest(array['anon','authenticated']) r
        cross join unnest(array[
          'public.xiaoc_memory_guard_append_only()',
          'public.xiaoc_memory_guard_embedding_transition()',
          'public.xiaoc_memory_guard_import_run()',
          'public.xiaoc_memory_guard_item_immutable()',
          'public.xiaoc_memory_guard_operation_transition()'
        ]) signature where has_function_privilege(r,signature,'EXECUTE'))=12
union all
select 'core baseline is 80', count(*)=80
from unnest(array['anon','authenticated']) r
cross join unnest(array[
  'public.conversation_summary','public.conversations','public.memories','public.messages','public.user_state'
]) object_name
cross join unnest(array[
  'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
]) privilege_name
where has_table_privilege(r,object_name,privilege_name)
union all
select 'high-risk baseline is 140', count(*)=140
from pg_class c join pg_namespace n on n.oid=c.relnamespace
cross join unnest(array['anon','authenticated']) r
cross join unnest(array['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) privilege_name
where n.nspname='public' and c.relkind in ('r','p')
  and has_table_privilege(r,c.oid,privilege_name)
union all
select 'default ACL baseline is 24', count(*)=24
from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace
cross join lateral aclexplode(d.defaclacl) x
left join pg_roles grantee on grantee.oid=x.grantee
join pg_roles owner_role on owner_role.oid=d.defaclrole
where n.nspname='public' and owner_role.rolname='postgres'
  and ((grantee.rolname in ('anon','authenticated') and d.defaclobjtype in ('r','S','f'))
    or (x.grantee=0 and d.defaclobjtype='f'))
union all
select 'sequence baseline is 48', count(*)=48
from pg_class c join pg_namespace n on n.oid=c.relnamespace
cross join unnest(array['anon','authenticated']) r
cross join unnest(array['SELECT','USAGE','UPDATE']) privilege_name
where n.nspname='public' and c.relkind='S'
  and has_sequence_privilege(r,c.oid,privilege_name);

rollback;

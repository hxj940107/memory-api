-- Read-only M2C.3 validation. Expected result: every row has pass = true.

begin transaction read only;

select 'check_pending denied to anon/authenticated' as check_name,
       not has_function_privilege('anon', 'public.check_pending_moments_for_xiaoc()', 'EXECUTE')
       and not has_function_privilege('authenticated', 'public.check_pending_moments_for_xiaoc()', 'EXECUTE') as pass,
       null::text as detail
union all
select 'check_pending retained for service_role',
       has_function_privilege('service_role', 'public.check_pending_moments_for_xiaoc()', 'EXECUTE'), null
union all
select 'no public function executable by anon/authenticated',
       not exists (
         select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public'
           and (has_function_privilege('anon',p.oid,'EXECUTE')
             or has_function_privilege('authenticated',p.oid,'EXECUTE'))
       ), null
union all
select 'core tables denied to anon/authenticated',
       not exists (
         select 1
         from unnest(array['anon','authenticated']) r
         cross join unnest(array[
           'public.conversation_summary','public.conversations','public.memories','public.messages','public.user_state'
         ]) t
         cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
         where has_table_privilege(r,t,p)
       ), null
union all
select 'no public table has anon/auth high-risk privilege including MAINTAIN',
       not exists (
         select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
         cross join unnest(array['anon','authenticated']) r
         cross join unnest(array['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
         where n.nspname='public' and c.relkind in ('r','p')
           and has_table_privilege(r,c.oid,p)
       ), null
union all
select 'no public sequence accessible to anon/authenticated',
       not exists (
         select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
         cross join unnest(array['anon','authenticated']) r
         cross join unnest(array['SELECT','USAGE','UPDATE']) p
         where n.nspname='public' and c.relkind='S'
           and has_sequence_privilege(r,c.oid,p)
       ), null
union all
select 'future public defaults deny PUBLIC/anon/authenticated',
       not exists (
         select 1 from pg_default_acl d
         join pg_namespace n on n.oid=d.defaclnamespace
         cross join lateral aclexplode(d.defaclacl) x
         left join pg_roles grantee on grantee.oid=x.grantee
         join pg_roles owner_role on owner_role.oid=d.defaclrole
         where n.nspname='public' and owner_role.rolname='postgres'
           and (
             (grantee.rolname in ('anon','authenticated') and d.defaclobjtype in ('r','S','f'))
             or (x.grantee=0 and d.defaclobjtype='f')
           )
       ), null
union all
select 'service core table lane retained',
       not exists (
         select 1
         from unnest(array[
           'public.conversation_summary','public.conversations','public.memories','public.messages','public.user_state'
         ]) t
         cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
         where not has_table_privilege('service_role',t,p)
       ), null
union all
select 'service sequence lane retained',
       not exists (
         select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and c.relkind='S'
           and not has_sequence_privilege('service_role',c.oid,'USAGE')
       ), null
union all
select 'Memory Engine callable RPCs remain service-only',
       not exists (
         select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname like 'xiaoc_memory_%'
           and p.prorettype <> 'trigger'::regtype
           and (
             has_function_privilege('anon',p.oid,'EXECUTE')
             or has_function_privilege('authenticated',p.oid,'EXECUTE')
             or (
               p.proname not in ('xiaoc_memory_assert_verified_integrity','xiaoc_memory_retrieval_row_eligible')
               and not has_function_privilege('service_role',p.oid,'EXECUTE')
             )
           )
       ), null
union all
select 'worker RPCs retain service execute',
       has_function_privilege('service_role','public.claim_moment_check(text,text,text,text,integer)','EXECUTE')
       and has_function_privilege('service_role','public.cleanup_xiaoc_observability_audits(integer)','EXECUTE'), null
union all
select 'canonical writer service grant is explicit',
       exists (
         select 1 from pg_proc p
         cross join lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) x
         join pg_roles grantee on grantee.oid=x.grantee
         where p.oid='public.check_pending_moments_for_xiaoc()'::regprocedure
           and grantee.rolname='service_role' and x.privilege_type='EXECUTE'
       ), null
union all
select 'canonical inherited guard service grants stay non-explicit',
       not exists (
         select 1
         from unnest(array[
           'public.xiaoc_memory_guard_append_only()',
           'public.xiaoc_memory_guard_embedding_transition()',
           'public.xiaoc_memory_guard_import_run()'
         ]) function_name
         join pg_proc p on p.oid=function_name::regprocedure
         cross join lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) x
         join pg_roles grantee on grantee.oid=x.grantee
         where grantee.rolname='service_role' and x.privilege_type='EXECUTE'
       ), null;

rollback;

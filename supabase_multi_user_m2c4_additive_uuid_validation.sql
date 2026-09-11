-- Read-only M2C.4 validation. Expected result: every row has pass = true.

begin transaction read only;

select 'companion root is empty and Auth-backed' as check_name,
       to_regclass('public.companion_instances') is not null
       and not exists (select 1 from public.companion_instances)
       and exists (
         select 1 from pg_constraint
         where conrelid='public.companion_instances'::regclass
           and conname='companion_instances_user_id_fkey'
           and confrelid='auth.users'::regclass
           and contype='f' and convalidated
       ) as pass
union all
select 'five UUID bridges are nullable with no default',
       count(*) = 5
       and bool_and(udt_name='uuid' and is_nullable='YES' and column_default is null)
from information_schema.columns
where table_schema='public'
  and table_name in ('conversations','messages','memories','conversation_summary','user_state')
  and column_name='user_uuid'
union all
select 'all UUID bridges remain empty',
       not exists (select 1 from public.conversations where user_uuid is not null)
       and not exists (select 1 from public.messages where user_uuid is not null)
       and not exists (select 1 from public.memories where user_uuid is not null)
       and not exists (select 1 from public.conversation_summary where user_uuid is not null)
       and not exists (select 1 from public.user_state where user_uuid is not null)
union all
select 'five root FKs exist unvalidated',
       count(*)=5 and bool_and(not convalidated)
from pg_constraint
where conname in (
  'conversations_user_uuid_fkey','messages_user_uuid_fkey','memories_user_uuid_fkey',
  'conversation_summary_user_uuid_fkey','user_state_user_uuid_fkey'
)
  and contype='f' and confrelid='public.companion_instances'::regclass
union all
select 'tenant-qualified unique foundation exists',
       count(*)=5
from pg_constraint
where conname in (
  'conversations_user_uuid_conversation_id_key','messages_user_uuid_id_key',
  'memories_user_uuid_id_key','conversation_summary_user_uuid_conversation_id_key',
  'user_state_user_uuid_key'
)
  and contype='u'
union all
select 'tenant access indexes exist and are valid',
       count(*)=3 and bool_and(i.indisvalid and i.indisready)
from pg_index i
join pg_class idx on idx.oid=i.indexrelid
join pg_namespace n on n.oid=idx.relnamespace
where n.nspname='public'
  and idx.relname in (
    'conversations_user_uuid_created_at_idx',
    'messages_user_uuid_conversation_created_idx',
    'memories_user_uuid_created_at_idx'
  )
union all
select 'legacy owner and identity columns remain unchanged',
       count(*)=11
from information_schema.columns
where table_schema='public' and (
  (table_name='conversations' and column_name in ('user_id','conversation_id') and udt_name='text')
  or (table_name='messages' and column_name in ('user_id','conversation_id') and udt_name='text')
  or (table_name='messages' and column_name='id' and udt_name='uuid')
  or (table_name='memories' and column_name='user_id' and udt_name='text')
  or (table_name='memories' and column_name='id' and udt_name='uuid')
  or (table_name='conversation_summary' and column_name='conversation_id' and udt_name='text')
  or (table_name='conversation_summary' and column_name='id' and udt_name='int8')
  or (table_name='user_state' and column_name in ('user_id','last_conversation_id') and udt_name='text')
)
union all
select 'legacy primary and Summary unique keys remain',
       count(*)=5
       and bool_and(con.contype=expected.constraint_type)
       and bool_and(pg_get_constraintdef(con.oid,true)=expected.constraint_definition)
from (values
  ('public.conversations'::regclass, 'conversations_pkey', 'p'::"char", 'PRIMARY KEY (conversation_id)'),
  ('public.messages'::regclass, 'messages_pkey', 'p'::"char", 'PRIMARY KEY (id)'),
  ('public.memories'::regclass, 'memories_pkey', 'p'::"char", 'PRIMARY KEY (id)'),
  ('public.user_state'::regclass, 'user_state_pkey', 'p'::"char", 'PRIMARY KEY (user_id)'),
  ('public.conversation_summary'::regclass, 'conversation_summary_conversation_id_key', 'u'::"char", 'UNIQUE (conversation_id)')
) as expected(table_oid,constraint_name,constraint_type,constraint_definition)
join pg_constraint con
  on con.conrelid=expected.table_oid
 and con.conname=expected.constraint_name
union all
select 'Core RLS remains disabled',
       count(*) filter (where not c.relrowsecurity and not c.relforcerowsecurity)=5
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public'
  and c.relname in ('conversations','messages','memories','conversation_summary','user_state')
union all
select 'ordinary roles remain denied on root and Core',
       not exists (
         select 1
         from unnest(array['anon','authenticated']) role_name
         cross join unnest(array[
           'public.companion_instances','public.conversations','public.messages',
           'public.memories','public.conversation_summary','public.user_state'
         ]) table_name
         cross join unnest(array[
           'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
         ]) privilege_name
         where has_table_privilege(role_name,table_name,privilege_name)
       )
union all
select 'service_role compatibility lane remains',
       not exists (
         select 1
         from unnest(array[
           'public.companion_instances','public.conversations','public.messages',
           'public.memories','public.conversation_summary','public.user_state'
         ]) table_name
         cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) privilege_name
         where not has_table_privilege('service_role',table_name,privilege_name)
       );

rollback;

-- Multi-user M2C.4: additive UUID tenant foundation only.
-- PREPARED ONLY. Do not run without a separate Production preflight and approval.
-- No owner backfill, legacy-column replacement, RLS, policy, RPC, Storage,
-- application, Ombre, or M2C.5 change is included.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_advisory_xact_lock(hashtextextended('xiaoc:multi-user:m2c4:additive-uuid-foundation', 0));

do $m2c4_preflight$
declare
  v_existing_bridges integer;
  v_legacy_type_matches integer;
  v_rls_enabled integer;
begin
  if to_regclass('auth.users') is null then
    raise exception 'M2C4_AUTH_USERS_MISSING';
  end if;

  if exists (
    select 1
    from unnest(array[
      'public.conversations',
      'public.messages',
      'public.memories',
      'public.conversation_summary',
      'public.user_state'
    ]) as expected(name)
    where to_regclass(expected.name) is null
  ) then
    raise exception 'M2C4_EXPECTED_CORE_TABLE_MISSING';
  end if;

  select count(*) into v_existing_bridges
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('conversations','messages','memories','conversation_summary','user_state')
    and column_name = 'user_uuid';

  if to_regclass('public.companion_instances') is not null or v_existing_bridges <> 0 then
    raise exception 'M2C4_PARTIAL_OR_ALREADY_APPLIED: companion_instances=%, bridge_columns=%',
      to_regclass('public.companion_instances'), v_existing_bridges;
  end if;

  select count(*) into v_legacy_type_matches
    from information_schema.columns
    where table_schema = 'public'
      and (
        (table_name = 'conversations' and column_name in ('user_id','conversation_id') and udt_name = 'text')
        or (table_name = 'messages' and column_name in ('user_id','conversation_id') and udt_name = 'text')
        or (table_name = 'messages' and column_name = 'id' and udt_name = 'uuid')
        or (table_name = 'memories' and column_name = 'user_id' and udt_name = 'text')
        or (table_name = 'memories' and column_name = 'id' and udt_name = 'uuid')
        or (table_name = 'conversation_summary' and column_name = 'conversation_id' and udt_name = 'text')
        or (table_name = 'conversation_summary' and column_name = 'id' and udt_name = 'int8')
        or (table_name = 'user_state' and column_name in ('user_id','last_conversation_id') and udt_name = 'text')
      );

  if v_legacy_type_matches <> 11 then
    raise exception 'M2C4_LEGACY_TYPE_DRIFT: matches=%', v_legacy_type_matches;
  end if;

  select count(*) into v_rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('conversations','messages','memories','conversation_summary','user_state')
    and c.relrowsecurity;

  if v_rls_enabled <> 0 then
    raise exception 'M2C4_RLS_BASELINE_DRIFT: enabled=%', v_rls_enabled;
  end if;

  if exists (
    select 1
    from unnest(array['anon','authenticated']) role_name
    cross join unnest(array[
      'public.conversations','public.messages','public.memories',
      'public.conversation_summary','public.user_state'
    ]) table_name
    cross join unnest(array[
      'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
    ]) privilege_name
    where has_table_privilege(role_name, table_name, privilege_name)
  ) then
    raise exception 'M2C4_M2C3_CORE_CONTAINMENT_MISSING';
  end if;
end
$m2c4_preflight$;

create table public.companion_instances (
  user_id uuid not null,
  lifecycle_status text not null default 'provisioning',
  foundation_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companion_instances_pkey primary key (user_id),
  constraint companion_instances_user_id_fkey
    foreign key (user_id) references auth.users(id)
    on update restrict on delete restrict,
  constraint companion_instances_lifecycle_status_check
    check (lifecycle_status in ('provisioning','active','suspended','pending_deletion')),
  constraint companion_instances_foundation_version_check
    check (foundation_version >= 1)
);

comment on table public.companion_instances is
  'Auth-backed tenant lifecycle root. M2C.4 creates this table empty.';
comment on column public.companion_instances.user_id is
  'Canonical tenant identity; exactly auth.users.id.';

alter table public.conversations add column user_uuid uuid;
alter table public.messages add column user_uuid uuid;
alter table public.memories add column user_uuid uuid;
alter table public.conversation_summary add column user_uuid uuid;
alter table public.user_state add column user_uuid uuid;

comment on column public.conversations.user_uuid is 'Nullable M2C bridge; non-authoritative until later cutover.';
comment on column public.messages.user_uuid is 'Nullable M2C bridge; non-authoritative until later cutover.';
comment on column public.memories.user_uuid is 'Nullable M2C bridge; non-authoritative until later cutover.';
comment on column public.conversation_summary.user_uuid is 'Nullable M2C Summary/Core owner bridge; non-authoritative until later cutover.';
comment on column public.user_state.user_uuid is 'Nullable M2C bridge; non-authoritative until later cutover.';

-- NOT VALID avoids a historical-table validation scan. It still rejects any
-- future non-null UUID that has no companion root. Validation belongs to M2C.6.
alter table public.conversations add constraint conversations_user_uuid_fkey
  foreign key (user_uuid) references public.companion_instances(user_id)
  on update restrict on delete restrict not valid;
alter table public.messages add constraint messages_user_uuid_fkey
  foreign key (user_uuid) references public.companion_instances(user_id)
  on update restrict on delete restrict not valid;
alter table public.memories add constraint memories_user_uuid_fkey
  foreign key (user_uuid) references public.companion_instances(user_id)
  on update restrict on delete restrict not valid;
alter table public.conversation_summary add constraint conversation_summary_user_uuid_fkey
  foreign key (user_uuid) references public.companion_instances(user_id)
  on update restrict on delete restrict not valid;
alter table public.user_state add constraint user_state_user_uuid_fkey
  foreign key (user_uuid) references public.companion_instances(user_id)
  on update restrict on delete restrict not valid;

-- These full unique keys can become referenced sides of tenant-qualified FKs
-- in M2C.6. PostgreSQL permits multiple legacy rows while user_uuid is null.
alter table public.conversations add constraint conversations_user_uuid_conversation_id_key
  unique (user_uuid, conversation_id);
alter table public.messages add constraint messages_user_uuid_id_key
  unique (user_uuid, id);
alter table public.memories add constraint memories_user_uuid_id_key
  unique (user_uuid, id);
alter table public.conversation_summary add constraint conversation_summary_user_uuid_conversation_id_key
  unique (user_uuid, conversation_id);
alter table public.user_state add constraint user_state_user_uuid_key
  unique (user_uuid);

create index conversations_user_uuid_created_at_idx
  on public.conversations (user_uuid, created_at desc, conversation_id);
create index messages_user_uuid_conversation_created_idx
  on public.messages (user_uuid, conversation_id, created_at, id);
create index memories_user_uuid_created_at_idx
  on public.memories (user_uuid, created_at desc, id);

commit;

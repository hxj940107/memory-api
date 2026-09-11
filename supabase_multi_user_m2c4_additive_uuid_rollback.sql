-- M2C.4 rollback. Run only before M2C.5 and only while every UUID bridge and
-- companion_instances remain empty.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_advisory_xact_lock(hashtextextended('xiaoc:multi-user:m2c4:additive-uuid-foundation', 0));

do $m2c4_rollback_guard$
begin
  if to_regclass('public.companion_instances') is null then
    raise exception 'M2C4_ROLLBACK_FOUNDATION_MISSING';
  end if;

  if exists (select 1 from public.companion_instances)
    or exists (select 1 from public.conversations where user_uuid is not null)
    or exists (select 1 from public.messages where user_uuid is not null)
    or exists (select 1 from public.memories where user_uuid is not null)
    or exists (select 1 from public.conversation_summary where user_uuid is not null)
    or exists (select 1 from public.user_state where user_uuid is not null)
  then
    raise exception 'M2C4_ROLLBACK_REFUSED_UUID_DATA_EXISTS';
  end if;
end
$m2c4_rollback_guard$;

drop index public.conversations_user_uuid_created_at_idx;
drop index public.messages_user_uuid_conversation_created_idx;
drop index public.memories_user_uuid_created_at_idx;

alter table public.conversations drop constraint conversations_user_uuid_conversation_id_key;
alter table public.messages drop constraint messages_user_uuid_id_key;
alter table public.memories drop constraint memories_user_uuid_id_key;
alter table public.conversation_summary drop constraint conversation_summary_user_uuid_conversation_id_key;
alter table public.user_state drop constraint user_state_user_uuid_key;

alter table public.conversations drop constraint conversations_user_uuid_fkey;
alter table public.messages drop constraint messages_user_uuid_fkey;
alter table public.memories drop constraint memories_user_uuid_fkey;
alter table public.conversation_summary drop constraint conversation_summary_user_uuid_fkey;
alter table public.user_state drop constraint user_state_user_uuid_fkey;

alter table public.conversations drop column user_uuid;
alter table public.messages drop column user_uuid;
alter table public.memories drop column user_uuid;
alter table public.conversation_summary drop column user_uuid;
alter table public.user_state drop column user_uuid;

drop table public.companion_instances;

commit;

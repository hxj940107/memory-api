-- Apply AFTER supabase_xiaoc_memory_event_capture.sql, while background reevaluation is OFF.
-- Repeatable function-only migration. No existing rows or Memory content are changed here.
begin;
set local lock_timeout = '10s';

do $preflight$
begin
  if to_regclass('public.memory_capture_events') is null
    or to_regprocedure('public.xiaoc_memory_event_decide(text,text,uuid,uuid,text,timestamp with time zone)') is null
    or to_regprocedure('public.xiaoc_memory_capture_event_verified(text,text,uuid,uuid,jsonb,text,text,jsonb,text)') is null then
    raise exception 'Current event-capture RPC contract required; keep reevaluation disabled';
  end if;
end;
$preflight$;

create or replace function public.xiaoc_memory_event_claim_expired(p_user_id text)
returns setof public.memory_capture_events language plpgsql security definer
set search_path = public, pg_catalog as $$
begin
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'owner required'; end if;
  -- Never requeue an abandoned lease. Newer chat turns have their own capture path.
  update public.memory_capture_events set status = 'closed', lease_until = null, updated_at = now()
    where user_id = p_user_id and (
      (status = 'evaluating' and (lease_until is null or lease_until <= now()))
      or (status = 'deferred' and attempts >= 2));
  return query
    with due as (
      select user_id, conversation_id, event_start_message_id from public.memory_capture_events
      where user_id = p_user_id and status = 'deferred' and expires_at <= now() and attempts < 2
      order by expires_at, conversation_id, event_start_message_id limit 3 for update skip locked
    )
    update public.memory_capture_events e set status = 'evaluating',
      lease_until = now() + interval '5 minutes', attempts = e.attempts + 1, updated_at = now()
    from due where e.user_id = due.user_id and e.conversation_id = due.conversation_id
      and e.event_start_message_id = due.event_start_message_id returning e.*;
end;
$$;

-- Versioned entry point makes new JS fail closed against an unpatched database.
create or replace function public.xiaoc_memory_event_claim_expired_v2(p_user_id text)
returns setof public.memory_capture_events language sql security definer
set search_path = public, pg_catalog as $$
  select * from public.xiaoc_memory_event_claim_expired(p_user_id);
$$;

create or replace function public.xiaoc_memory_event_finish_expired_v2(
  p_user_id text, p_conversation_id text, p_event_start_message_id uuid,
  p_expected_updated_at timestamptz
) returns text language plpgsql security definer
set search_path = public, pg_catalog as $$
declare v_event public.memory_capture_events%rowtype;
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_conversation_id is null
    or p_event_start_message_id is null or p_expected_updated_at is null then
    raise exception 'invalid expired event identity';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('memory-event:' || p_user_id || ':' || p_conversation_id, 0));
  select * into v_event from public.memory_capture_events
    where user_id = p_user_id and conversation_id = p_conversation_id
      and event_start_message_id = p_event_start_message_id for update;
  if not found then raise exception 'expired event missing'; end if;
  if v_event.status in ('closed', 'captured') then return v_event.status; end if;
  -- Explicitly report a newer owner of the event; never overwrite a concurrent chat update.
  if v_event.updated_at is distinct from p_expected_updated_at then return 'superseded'; end if;
  if v_event.status <> 'evaluating' then raise exception 'expired event is not claimed'; end if;
  update public.memory_capture_events set status = 'closed', lease_until = null, updated_at = now()
    where user_id = p_user_id and conversation_id = p_conversation_id
      and event_start_message_id = p_event_start_message_id;
  return 'closed';
end;
$$;

revoke all on function public.xiaoc_memory_event_claim_expired(text) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_event_claim_expired_v2(text) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_event_finish_expired_v2(text,text,uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.xiaoc_memory_event_claim_expired(text) to service_role;
grant execute on function public.xiaoc_memory_event_claim_expired_v2(text) to service_role;
grant execute on function public.xiaoc_memory_event_finish_expired_v2(text,text,uuid,timestamptz) to service_role;
notify pgrst, 'reload schema';
commit;

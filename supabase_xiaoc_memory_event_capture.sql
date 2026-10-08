-- Repeatable upgrade from the original event-capture migration or a fresh event schema.
-- No fixture execution, historical recapture, or existing-row mutation during migration.
begin;
set local lock_timeout = '10s';

-- Fail before DDL if the existing protected Memory foundation is unavailable.
do $preflight$
begin
  if to_regclass('public.messages') is null
    or to_regclass('public.memory_items') is null
    or to_regclass('public.memory_provenance') is null
    or to_regclass('public.memory_operations') is null
    or to_regprocedure('extensions.digest(bytea,text)') is null
    or to_regprocedure('public.xiaoc_memory_capture_verified(text,uuid,text,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,smallint,numeric,text,text,text)') is null then
    raise exception 'Existing protected Memory foundation is required; migration aborted without changes';
  end if;
end;
$preflight$;

create table if not exists public.memory_capture_events (
  user_id text not null,
  conversation_id text not null,
  event_start_message_id uuid not null references public.messages(id),
  last_message_id uuid not null references public.messages(id),
  status text not null check (status in ('deferred', 'evaluating', 'closed', 'captured')),
  expires_at timestamptz not null,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 2),
  memory_id uuid references public.memory_items(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, conversation_id, event_start_message_id)
);
create index if not exists memory_capture_events_due_idx on public.memory_capture_events(user_id, expires_at)
  where status in ('deferred', 'evaluating');
alter table public.memory_capture_events enable row level security;
revoke all on public.memory_capture_events from public, anon, authenticated, service_role;
grant select on public.memory_capture_events to service_role;

-- Adding a parameter creates a new overload, not a replacement in PostgreSQL.
-- Remove ONLY the original five-argument event function (never CASCADE).
-- The six-argument function's default preserves five-argument calls.
-- Any unexpected dependent object aborts and rolls back this transaction.
drop function if exists public.xiaoc_memory_event_decide(text,text,uuid,uuid,text);
create or replace function public.xiaoc_memory_event_decide(
  p_user_id text, p_conversation_id text, p_event_start_message_id uuid,
  p_current_message_id uuid, p_action text, p_expected_updated_at timestamptz default null
) returns void language plpgsql security definer
set search_path = public, extensions, pg_catalog as $$
declare
  v_root public.messages%rowtype;
  v_current public.messages%rowtype;
  v_progress public.messages%rowtype;
  v_event public.memory_capture_events%rowtype;
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_conversation_id is null
    or p_action is null or p_action not in ('defer', 'reject') then
    raise exception 'invalid event decision';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('memory-event:' || p_user_id || ':' || p_conversation_id, 0));
  select * into v_root from public.messages where id = p_event_start_message_id;
  select * into v_current from public.messages where id = p_current_message_id;
  if v_root.id is null or v_current.id is null
    or v_root.user_id is distinct from p_user_id or v_current.user_id is distinct from p_user_id
    or v_root.conversation_id is distinct from p_conversation_id or v_current.conversation_id is distinct from p_conversation_id
    or v_root.role is distinct from 'user' or v_current.role is distinct from 'user'
    or v_root.created_at > v_current.created_at then raise exception 'invalid event source'; end if;
  select * into v_event from public.memory_capture_events where user_id = p_user_id
    and conversation_id = p_conversation_id and event_start_message_id = p_event_start_message_id for update;
  select * into v_progress from public.messages where id = v_event.last_message_id;
  if p_expected_updated_at is not null and v_event.updated_at is distinct from p_expected_updated_at then return; end if;
  if v_event.status in ('captured', 'closed') then return; end if;
  if v_progress.id is not null and (v_progress.created_at, v_progress.id) > (v_current.created_at, v_current.id) then return; end if;
  -- A stale decision cannot terminate an episode while a newer persisted user turn exists.
  if p_action = 'reject' and exists (select 1 from public.messages where user_id = p_user_id
    and conversation_id = p_conversation_id and role = 'user'
    and (created_at, id) > (v_current.created_at, v_current.id)) then return; end if;
  if p_action = 'reject' then
    insert into public.memory_capture_events(user_id, conversation_id, event_start_message_id,
      last_message_id, status, expires_at)
    values(p_user_id, p_conversation_id, p_event_start_message_id, p_current_message_id, 'closed', now())
    on conflict(user_id, conversation_id, event_start_message_id) do update
      set status = 'closed', last_message_id = p_current_message_id, lease_until = null, updated_at = now()
      where memory_capture_events.status in ('deferred', 'evaluating');
    return;
  end if;
  if v_root.created_at < v_current.created_at - interval '2 hours'
    or (select count(*) from public.messages where user_id = p_user_id and conversation_id = p_conversation_id
      and role = 'user' and created_at between v_root.created_at and v_current.created_at) > 8 then
    raise exception 'event window ended';
  end if;
  if exists (select 1 from public.memory_capture_events where user_id = p_user_id
    and conversation_id = p_conversation_id and event_start_message_id = p_event_start_message_id
    and status in ('captured', 'closed')) then return; end if;
  if not exists (select 1 from public.memory_capture_events where user_id = p_user_id
    and conversation_id = p_conversation_id and event_start_message_id = p_event_start_message_id)
    and (select count(*) from public.memory_capture_events where user_id = p_user_id
      and conversation_id = p_conversation_id and status in ('deferred', 'evaluating')) >= 4 then
    raise exception 'event defer capacity exceeded';
  end if;
  insert into public.memory_capture_events(user_id, conversation_id, event_start_message_id,
    last_message_id, status, expires_at)
  values(p_user_id, p_conversation_id, p_event_start_message_id, p_current_message_id,
    'deferred', least(now() + interval '20 minutes', v_root.created_at + interval '2 hours'))
  on conflict(user_id, conversation_id, event_start_message_id) do update
    set last_message_id = excluded.last_message_id, updated_at = now(), status = 'deferred', lease_until = null
    where memory_capture_events.status = 'deferred'
      or (memory_capture_events.status = 'evaluating' and memory_capture_events.last_message_id <> excluded.last_message_id);
  -- expires_at deliberately never extends on subsequent turns.
end;
$$;

create or replace function public.xiaoc_memory_event_claim_expired(p_user_id text)
returns setof public.memory_capture_events language plpgsql security definer
set search_path = public, pg_catalog as $$
begin
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'owner required'; end if;
  update public.memory_capture_events e set status = 'deferred', lease_until = null, updated_at = now()
    where user_id = p_user_id and status = 'evaluating' and lease_until <= now()
      and exists (select 1 from public.messages m join public.messages old on old.id = e.last_message_id
        where m.user_id = e.user_id and m.conversation_id = e.conversation_id and m.role = 'user'
          and (m.created_at,m.id) > (old.created_at,old.id));
  update public.memory_capture_events set status = 'closed', lease_until = null, updated_at = now()
    where user_id = p_user_id and status = 'evaluating' and lease_until <= now();
  return query
    with due as (
      select user_id, conversation_id, event_start_message_id from public.memory_capture_events
      where user_id = p_user_id and status = 'deferred' and expires_at <= now()
      order by expires_at limit 3 for update skip locked
    )
    update public.memory_capture_events e set status = 'evaluating',
      lease_until = now() + interval '5 minutes', attempts = least(2, e.attempts + 1), updated_at = now()
    from due where e.user_id = due.user_id and e.conversation_id = due.conversation_id
      and e.event_start_message_id = due.event_start_message_id returning e.*;
end;
$$;

create or replace function public.xiaoc_memory_capture_event_verified(
  p_user_id text, p_conversation_id text, p_event_start_message_id uuid,
  p_current_message_id uuid, p_sources jsonb, p_canonical_content text,
  p_category text, p_temporal jsonb, p_idempotency_key text
) returns uuid language plpgsql security definer
set search_path = public, extensions, pg_catalog as $$
declare
  v_root public.messages%rowtype;
  v_current public.messages%rowtype;
  v_source public.messages%rowtype;
  v_evidence jsonb;
  v_first jsonb;
  v_memory_id uuid;
  v_existing public.memory_capture_events%rowtype;
  v_progress public.messages%rowtype;
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_conversation_id is null
    or p_idempotency_key is distinct from 'capture-event-v1:' || p_conversation_id || ':' || p_event_start_message_id::text
    or p_canonical_content is null or btrim(p_canonical_content) = '' or length(p_canonical_content) > 4000
    or p_canonical_content ~* '(用户|\muser\M)'
    or p_category is null or p_category not in ('personal_fact','relationship_memory','relationship_preference','meaningful_experience','long_term_concern')
    or jsonb_typeof(p_sources) is distinct from 'array' then raise exception 'invalid event capture'; end if;
  if jsonb_array_length(p_sources) not between 1 and 8 then raise exception 'invalid evidence count'; end if;
  perform pg_advisory_xact_lock(hashtextextended('memory-event:' || p_user_id || ':' || p_conversation_id, 0));
  select * into v_root from public.messages where id = p_event_start_message_id;
  select * into v_current from public.messages where id = p_current_message_id;
  if v_root.id is null or v_current.id is null
    or v_root.user_id is distinct from p_user_id or v_current.user_id is distinct from p_user_id
    or v_root.conversation_id is distinct from p_conversation_id or v_current.conversation_id is distinct from p_conversation_id
    or v_root.role is distinct from 'user' or v_current.role is distinct from 'user'
    or v_root.created_at > v_current.created_at
    or v_root.created_at < v_current.created_at - interval '2 hours' then raise exception 'event source scope invalid'; end if;
  if (select count(*) from public.messages where user_id = p_user_id and conversation_id = p_conversation_id
    and role = 'user' and created_at between v_root.created_at and v_current.created_at) > 8 then
    raise exception 'event turn window ended';
  end if;
  if not exists (select 1 from jsonb_array_elements(p_sources) x where x->>'source_message_id' = p_event_start_message_id::text)
    or (select count(distinct x->>'source_message_id') from jsonb_array_elements(p_sources) x) <> jsonb_array_length(p_sources)
    then raise exception 'event identity evidence required'; end if;
  for v_evidence in select value from jsonb_array_elements(p_sources) loop
    select * into v_source from public.messages where id = (v_evidence->>'source_message_id')::uuid;
    if v_source.id is null or v_source.user_id is distinct from p_user_id
      or v_source.conversation_id is distinct from p_conversation_id or v_source.role is distinct from 'user'
      or v_evidence->>'source_role' is distinct from 'user'
      or v_source.created_at < v_root.created_at or v_source.created_at > v_current.created_at
      or coalesce(btrim(v_evidence->>'evidence_text'), '') = ''
      or position(v_evidence->>'evidence_text' in coalesce(v_source.content, '')) = 0
      or v_evidence->>'evidence_type' is null
      or v_evidence->>'evidence_type' not in ('assertion','confirmation','correction','question','other')
      then raise exception 'invalid exact event evidence'; end if;
  end loop;
  select * into v_existing from public.memory_capture_events
    where user_id = p_user_id and conversation_id = p_conversation_id and event_start_message_id = p_event_start_message_id for update;
  if v_existing.status = 'captured' then return v_existing.memory_id; end if;
  if v_existing.status = 'closed' then raise exception 'closed event cannot reopen'; end if;
  select * into v_progress from public.messages where id = v_existing.last_message_id;
  if v_progress.id is not null and (v_progress.created_at,v_progress.id) > (v_current.created_at,v_current.id) then
    raise exception 'stale event capture'; end if;
  -- A trusted event root already present in provenance cannot generate a fragment.
  -- No fuzzy hash match, no deletion, and no rewriting of a prior Memory.
  select p.memory_id into v_memory_id from public.memory_provenance p
    where p.user_id = p_user_id and p.source_conversation_id = p_conversation_id
      and p.source_message_id = p_event_start_message_id limit 1;
  if v_memory_id is null then
    select p.memory_id into v_memory_id from public.memory_provenance p
      join jsonb_array_elements(p_sources) x on p.source_message_id::text = x->>'source_message_id'
        and p.evidence_hash = encode(extensions.digest(convert_to(x->>'evidence_text','UTF8'),'sha256'),'hex')
      where p.user_id = p_user_id and p.source_conversation_id = p_conversation_id limit 1;
  end if;
  if v_memory_id is not null then raise exception 'event source already captured'; end if;
  v_first := p_sources->0;
  -- Reuse the legacy protected writer inside this transaction. Any later failure
  -- rolls back memory, its operation, every provenance row, and event state.
  v_memory_id := public.xiaoc_memory_capture_verified(
    p_user_id, (v_first->>'source_message_id')::uuid, p_conversation_id,
    v_first->>'evidence_text', v_first->>'evidence_type', p_canonical_content,
    'observation', p_category, null,
    (p_temporal->>'event_time')::timestamptz, (p_temporal->>'valid_from')::timestamptz,
    (p_temporal->>'valid_until')::timestamptz, null::smallint, null::numeric,
    'xiaoc-event-capture-v1', 'xiaoc-native-authority-v1', p_idempotency_key);
  for v_evidence in select value from jsonb_array_elements(p_sources) loop
    select * into v_source from public.messages where id = (v_evidence->>'source_message_id')::uuid;
    insert into public.memory_provenance(user_id, memory_id, source_kind, source_locator_key,
      source_message_id, source_conversation_id, source_role, evidence_text, evidence_hash, evidence_type, observed_at)
    values(p_user_id, v_memory_id, 'message', 'message:' || v_source.id::text,
      v_source.id, p_conversation_id, 'user', v_evidence->>'evidence_text',
      encode(extensions.digest(convert_to(v_evidence->>'evidence_text','UTF8'),'sha256'),'hex'),
      v_evidence->>'evidence_type', v_source.created_at)
    on conflict(user_id, memory_id, source_kind, source_locator_key, evidence_hash) do nothing;
  end loop;
  insert into public.memory_capture_events(user_id, conversation_id, event_start_message_id,
    last_message_id, status, expires_at, memory_id)
  values(p_user_id, p_conversation_id, p_event_start_message_id, p_current_message_id, 'captured', now(), v_memory_id)
  on conflict(user_id, conversation_id, event_start_message_id) do update
    set status = 'captured', memory_id = excluded.memory_id, last_message_id = excluded.last_message_id,
      lease_until = null, updated_at = now();
  return v_memory_id;
end;
$$;

revoke all on function public.xiaoc_memory_event_decide(text,text,uuid,uuid,text,timestamptz) from public,anon,authenticated;
revoke all on function public.xiaoc_memory_event_claim_expired(text) from public,anon,authenticated;
revoke all on function public.xiaoc_memory_capture_event_verified(text,text,uuid,uuid,jsonb,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.xiaoc_memory_event_decide(text,text,uuid,uuid,text,timestamptz) to service_role;
grant execute on function public.xiaoc_memory_event_claim_expired(text) to service_role;
grant execute on function public.xiaoc_memory_capture_event_verified(text,text,uuid,uuid,jsonb,text,text,jsonb,text) to service_role;
-- Refresh PostgREST's RPC signature cache after the transaction commits.
notify pgrst, 'reload schema';
commit;

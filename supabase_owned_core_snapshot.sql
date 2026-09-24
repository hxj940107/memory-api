-- XiaoC Owned Core Snapshot.
-- Additive: preserves the existing Ombre Core snapshot columns and data.

alter table public.conversation_summary
  add column if not exists owned_core_memory_snapshot text,
  add column if not exists owned_core_memory_snapshot_hash text,
  add column if not exists owned_core_memory_snapshot_created_at timestamptz,
  add column if not exists owned_core_memory_source_ids uuid[],
  add column if not exists owned_core_memory_sources jsonb;

comment on column public.conversation_summary.owned_core_memory_snapshot is
  'Frozen conversation-scoped Core rendered from XiaoC-owned memory_pins; independent of legacy Ombre snapshots.';
comment on column public.conversation_summary.owned_core_memory_sources is
  'Ordered [{memory_id,content_hash}] manifest for the frozen Owned Core snapshot.';

create or replace function public.xiaoc_memory_set_pin(
  p_user_id text,
  p_memory_id uuid,
  p_active boolean,
  p_ordinal integer,
  p_policy_version text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_operation_id uuid;
  v_memory public.memory_items%rowtype;
begin
  if nullif(btrim(p_user_id), '') is null then raise exception 'PIN owner is required'; end if;
  if p_ordinal is null or p_ordinal < 0 then raise exception 'PIN ordinal must be nonnegative'; end if;
  if nullif(btrim(p_policy_version), '') is null or nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'PIN operation identity is required';
  end if;

  select * into v_memory
  from public.memory_items
  where user_id = p_user_id and id = p_memory_id
  for update;
  if not found then raise exception 'same-user memory not found'; end if;

  if p_active and not (
    v_memory.lifecycle_status = 'active'
    and (
      (
        v_memory.origin_system = 'xiaoc_native'
        and v_memory.provenance_status in ('verified_user', 'derived_verified', 'manual_confirmed')
        and v_memory.retrieval_tier is null
        and v_memory.authority_tier = 'native_verified'
      )
      or
      (
        v_memory.origin_system = 'ombre_legacy'
        and v_memory.provenance_status = 'legacy_unverified'
        and v_memory.retrieval_tier = 'low_authority'
        and v_memory.authority_tier = 'legacy_limited'
      )
    )
  ) then
    raise exception 'memory is not eligible for owned Core PIN';
  end if;

  insert into public.memory_operations (
    user_id, operation_type, idempotency_key, actor_type, policy_version
  ) values (
    p_user_id, case when p_active then 'pin' else 'unpin' end,
    p_idempotency_key, 'user', p_policy_version
  )
  on conflict (user_id, operation_type, idempotency_key) do nothing
  returning id into v_operation_id;

  if v_operation_id is null then
    select id into v_operation_id
    from public.memory_operations
    where user_id = p_user_id
      and operation_type = case when p_active then 'pin' else 'unpin' end
      and idempotency_key = p_idempotency_key
      and result_status = 'success';
    if v_operation_id is null then raise exception 'PIN operation in progress or failed'; end if;
    return v_operation_id;
  end if;

  insert into public.memory_pins (
    user_id, memory_id, scope, ordinal, pin_status, pinned_by,
    operation_id, pinned_at, unpinned_at
  ) values (
    p_user_id, p_memory_id, 'core', p_ordinal,
    case when p_active then 'active' else 'inactive' end,
    'user', v_operation_id, now(), case when p_active then null else now() end
  )
  on conflict (user_id, memory_id, scope) do update set
    ordinal = excluded.ordinal,
    pin_status = excluded.pin_status,
    operation_id = excluded.operation_id,
    pinned_at = case when excluded.pin_status = 'active' then now() else memory_pins.pinned_at end,
    unpinned_at = excluded.unpinned_at;

  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, array[p_memory_id]
  );
  return v_operation_id;
end;
$$;

create or replace function public.xiaoc_memory_initialize_owned_core_snapshot(
  p_user_id text,
  p_conversation_id text
)
returns table (
  owned_core_memory_snapshot text,
  owned_core_memory_snapshot_hash text,
  owned_core_memory_snapshot_created_at timestamptz,
  owned_core_memory_source_ids uuid[],
  owned_core_memory_sources jsonb
)
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_snapshot text;
  v_hash text;
  v_source_ids uuid[];
  v_sources jsonb;
  v_active_pin_count integer;
  v_eligible_pin_count integer;
begin
  if nullif(btrim(p_user_id), '') is null or nullif(btrim(p_conversation_id), '') is null then
    raise exception 'Owned Core owner and conversation are required';
  end if;

  perform 1 from public.conversations
  where user_id = p_user_id and conversation_id = p_conversation_id
  for update;
  if not found then raise exception 'same-user conversation not found'; end if;

  if exists (
    select 1 from public.conversation_summary cs
    where cs.conversation_id = p_conversation_id
      and nullif(btrim(cs.owned_core_memory_snapshot), '') is not null
  ) then
    return query select
      cs.owned_core_memory_snapshot,
      cs.owned_core_memory_snapshot_hash,
      cs.owned_core_memory_snapshot_created_at,
      cs.owned_core_memory_source_ids,
      cs.owned_core_memory_sources
    from public.conversation_summary cs
    where cs.conversation_id = p_conversation_id;
    return;
  end if;

  select count(*) into v_active_pin_count
  from public.memory_pins p
  where p.user_id = p_user_id and p.scope = 'core' and p.pin_status = 'active';

  with eligible as (
    select p.ordinal, i.id, i.canonical_content, i.content_hash
    from public.memory_pins p
    join public.memory_items i on i.user_id = p.user_id and i.id = p.memory_id
    where p.user_id = p_user_id and p.scope = 'core' and p.pin_status = 'active'
      and i.lifecycle_status = 'active'
      and (
        (i.origin_system = 'xiaoc_native'
          and i.provenance_status in ('verified_user', 'derived_verified', 'manual_confirmed')
          and i.retrieval_tier is null and i.authority_tier = 'native_verified')
        or
        (i.origin_system = 'ombre_legacy'
          and i.provenance_status = 'legacy_unverified'
          and i.retrieval_tier = 'low_authority' and i.authority_tier = 'legacy_limited')
      )
  )
  select
    count(*),
    string_agg(canonical_content, E'\n\n---\n\n' order by ordinal, id),
    array_agg(id order by ordinal, id),
    jsonb_agg(jsonb_build_object('memory_id', id, 'content_hash', content_hash) order by ordinal, id)
  into v_eligible_pin_count, v_snapshot, v_source_ids, v_sources
  from eligible;

  if v_active_pin_count = 0 then raise exception 'Owned Core has no active PIN'; end if;
  if v_eligible_pin_count <> v_active_pin_count then
    raise exception 'Owned Core contains an ineligible active PIN';
  end if;

  v_hash := encode(extensions.digest(convert_to(v_snapshot, 'UTF8'), 'sha256'), 'hex');

  insert into public.conversation_summary (
    conversation_id,
    owned_core_memory_snapshot,
    owned_core_memory_snapshot_hash,
    owned_core_memory_snapshot_created_at,
    owned_core_memory_source_ids,
    owned_core_memory_sources
  ) values (
    p_conversation_id, v_snapshot, v_hash, now(), v_source_ids, v_sources
  )
  on conflict (conversation_id) do update set
    owned_core_memory_snapshot = excluded.owned_core_memory_snapshot,
    owned_core_memory_snapshot_hash = excluded.owned_core_memory_snapshot_hash,
    owned_core_memory_snapshot_created_at = excluded.owned_core_memory_snapshot_created_at,
    owned_core_memory_source_ids = excluded.owned_core_memory_source_ids,
    owned_core_memory_sources = excluded.owned_core_memory_sources
  where public.conversation_summary.owned_core_memory_snapshot is null
     or btrim(public.conversation_summary.owned_core_memory_snapshot) = '';

  return query select
    cs.owned_core_memory_snapshot,
    cs.owned_core_memory_snapshot_hash,
    cs.owned_core_memory_snapshot_created_at,
    cs.owned_core_memory_source_ids,
    cs.owned_core_memory_sources
  from public.conversation_summary cs
  where cs.conversation_id = p_conversation_id;
end;
$$;

create or replace function public.xiaoc_memory_invalidate_owned_core_on_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if old.lifecycle_status = 'active' and new.lifecycle_status <> 'active' then
    update public.conversation_summary cs set
      owned_core_memory_snapshot = null,
      owned_core_memory_snapshot_hash = null,
      owned_core_memory_snapshot_created_at = null,
      owned_core_memory_source_ids = null,
      owned_core_memory_sources = null
    where old.id = any(coalesce(cs.owned_core_memory_source_ids, '{}'::uuid[]));
  end if;
  return new;
end;
$$;

drop trigger if exists memory_items_owned_core_lifecycle_invalidation on public.memory_items;
create trigger memory_items_owned_core_lifecycle_invalidation
after update of lifecycle_status on public.memory_items
for each row
when (old.lifecycle_status is distinct from new.lifecycle_status)
execute function public.xiaoc_memory_invalidate_owned_core_on_lifecycle();

revoke all on function public.xiaoc_memory_set_pin(text, uuid, boolean, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.xiaoc_memory_initialize_owned_core_snapshot(text, text)
  from public, anon, authenticated;
revoke all on function public.xiaoc_memory_invalidate_owned_core_on_lifecycle()
  from public, anon, authenticated;

grant execute on function public.xiaoc_memory_set_pin(text, uuid, boolean, integer, text, text)
  to service_role;
grant execute on function public.xiaoc_memory_initialize_owned_core_snapshot(text, text)
  to service_role;


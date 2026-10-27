-- User applied in Private Supabase cncpymfqefyabiclnqzg and returned validation PASS.
-- Retained migration source; no prompt or worker integration. Do not rerun for deployment.
begin;

create table if not exists public.private_device_activity_uploads (
  owner_uuid uuid primary key references auth.users(id) on delete cascade,
  last_uploaded_at timestamptz
);
create table if not exists public.private_device_activity_events (
  owner_uuid uuid not null references auth.users(id) on delete cascade,
  event_id text not null check (event_id ~ '^[a-f0-9]{64}$'),
  app text not null check (app in ('xiaohongshu', 'douyin', 'taobao')),
  kind text not null check (kind in ('opened', 'left')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (owner_uuid, event_id)
);
create index if not exists private_device_activity_owner_time
  on public.private_device_activity_events(owner_uuid, occurred_at desc, event_id);
alter table public.private_device_activity_uploads enable row level security;
alter table public.private_device_activity_events enable row level security;
revoke all on public.private_device_activity_uploads, public.private_device_activity_events from public, anon, authenticated;
grant all on public.private_device_activity_uploads, public.private_device_activity_events to service_role;

create or replace function public.ingest_private_device_activity(p_owner uuid, p_events jsonb)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  v_last timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if not exists (select 1 from public.companion_instances where user_id = p_owner and lifecycle_status = 'active') then
    raise exception 'active companion required';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then raise exception 'invalid events'; end if;
  if jsonb_array_length(p_events) > 300 then raise exception 'too many events'; end if;
  insert into public.private_device_activity_uploads(owner_uuid) values(p_owner) on conflict do nothing;
  select last_uploaded_at into v_last from public.private_device_activity_uploads
    where owner_uuid = p_owner for update;
  if v_last > v_now - interval '5 minutes' then
    return jsonb_build_object('status', 'throttled', 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_last + interval '5 minutes' - v_now)))::int));
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_events) as e(event_id text, app text, kind text, occurred_at timestamptz)
    where e.occurred_at is null or e.occurred_at < v_now - interval '7 days'
      or e.occurred_at > v_now + interval '5 minutes'
  ) then raise exception 'invalid event time'; end if;
  insert into public.private_device_activity_events(owner_uuid, event_id, app, kind, occurred_at)
    select p_owner, e.event_id, e.app, e.kind, e.occurred_at
    from jsonb_to_recordset(p_events) as e(event_id text, app text, kind text, occurred_at timestamptz)
    on conflict (owner_uuid, event_id) do nothing;
  -- Opportunistic retention: idle owners are not automatically swept by this migration.
  delete from public.private_device_activity_events where owner_uuid = p_owner and occurred_at < v_now - interval '7 days';
  delete from public.private_device_activity_events where owner_uuid = p_owner and event_id in (
    select event_id from public.private_device_activity_events where owner_uuid = p_owner
    order by occurred_at desc, event_id offset 2000
  );
  update public.private_device_activity_uploads set last_uploaded_at = v_now where owner_uuid = p_owner;
  return jsonb_build_object('status', 'accepted');
end;
$$;
revoke all on function public.ingest_private_device_activity(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_private_device_activity(uuid, jsonb) to service_role;
commit;

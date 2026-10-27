-- Run the WHOLE file in XiaoC Private: cncpymfqefyabiclnqzg.
-- Requires the preceding supabase_private_device_activity.sql migration.
-- Uses the only active companion, never prints its UUID or real activity.
-- All test writes run inside a subtransaction that is ALWAYS rolled back.
-- Does not test concurrent sessions or prove HTTP token isolation.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
declare
  v_owner uuid;
  v_count int;
  v_result jsonb;
  v_events jsonb;
  v_id text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  v_second text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  v_old text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  v_role text;
  v_table text;
  v_privilege text;
begin
  -- Check effective role permissions, including grants inherited from PUBLIC.
  foreach v_table in array array['private_device_activity_events', 'private_device_activity_uploads'] loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity) then
      raise exception 'FAIL: RLS missing for %', v_table;
    end if;
    foreach v_role in array array['anon', 'authenticated'] loop
      foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(v_role, 'public.' || v_table, v_privilege) then
          raise exception 'FAIL: unexpected % permission for % on %', v_privilege, v_role, v_table;
        end if;
      end loop;
    end loop;
    foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', 'public.' || v_table, v_privilege) then
        raise exception 'FAIL: service_role missing % on %', v_privilege, v_table;
      end if;
    end loop;
  end loop;
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_role, 'public.ingest_private_device_activity(uuid,jsonb)', 'EXECUTE') then
      raise exception 'FAIL: unexpected RPC access for %', v_role;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.ingest_private_device_activity(uuid,jsonb)', 'EXECUTE') then
    raise exception 'FAIL: service_role missing RPC access';
  end if;

  select count(*) into v_count from public.companion_instances where lifecycle_status = 'active';
  if v_count <> 1 then
    raise exception 'STOP: expected exactly one active Private companion, found %; do not guess owner', v_count;
  end if;
  select user_id into v_owner from public.companion_instances where lifecycle_status = 'active';

  begin
    -- Temporarily reset only this feature's throttle row. Restored by subtransaction rollback.
    insert into public.private_device_activity_uploads(owner_uuid, last_uploaded_at)
      values(v_owner, null) on conflict (owner_uuid) do update set last_uploaded_at = null;
    v_events := jsonb_build_array(jsonb_build_object('event_id', v_id, 'app', 'douyin',
      'kind', 'opened', 'occurred_at', clock_timestamp() - interval '1 minute'));

    -- Exercise the RPC with the production service role, not only SQL Editor privileges.
    set local role service_role;
    v_result := public.ingest_private_device_activity(v_owner, v_events);
    if v_result->>'status' is distinct from 'accepted' then raise exception 'FAIL: first upload'; end if;

    v_result := public.ingest_private_device_activity(v_owner,
      jsonb_build_array(jsonb_build_object('event_id', v_second, 'app', 'taobao',
        'kind', 'left', 'occurred_at', clock_timestamp())));
    if v_result->>'status' is distinct from 'throttled'
      or (v_result->>'retry_after_seconds')::int not between 1 and 300 then
      raise exception 'FAIL: five-minute throttle';
    end if;
    if exists (select 1 from public.private_device_activity_events where owner_uuid = v_owner and event_id = v_second) then
      raise exception 'FAIL: throttled batch persisted';
    end if;

    update public.private_device_activity_uploads set last_uploaded_at = clock_timestamp() - interval '6 minutes'
      where owner_uuid = v_owner;
    v_result := public.ingest_private_device_activity(v_owner, v_events);
    select count(*) into v_count from public.private_device_activity_events where owner_uuid = v_owner and event_id = v_id;
    if v_result->>'status' is distinct from 'accepted' or v_count <> 1 then raise exception 'FAIL: retry deduplication'; end if;

    -- Stale rows are pruned on an accepted upload, not during idle time.
    insert into public.private_device_activity_events(owner_uuid, event_id, app, kind, occurred_at)
      values(v_owner, v_old, 'xiaohongshu', 'left', clock_timestamp() - interval '8 days');
    update public.private_device_activity_uploads set last_uploaded_at = clock_timestamp() - interval '6 minutes'
      where owner_uuid = v_owner;
    v_result := public.ingest_private_device_activity(v_owner, '[]'::jsonb);
    if v_result->>'status' is distinct from 'accepted' or exists (
      select 1 from public.private_device_activity_events where owner_uuid = v_owner and event_id = v_old
    ) then raise exception 'FAIL: upload-time retention'; end if;

    -- Deliberately abort the entire test subtransaction, including throttle and pruning.
    raise exception using errcode = 'ZDA01', message = 'expected_test_rollback';
  exception when sqlstate 'ZDA01' then
    null;
  end;
  -- SET ROLE above is also rolled back on leaving the aborted subtransaction.
  if exists (select 1 from public.private_device_activity_events where event_id in (v_id, v_second, v_old)) then
    raise exception 'FAIL: test rows survived rollback';
  end if;
end;
$$;

select 'PASS' as status,
  'RLS / role permissions / service-role RPC / deduplication / five-minute throttle / upload-time retention / test rollback' as checks,
  'No test writes retained. Concurrent uploads and HTTP behavior are not tested here.' as scope;
rollback;

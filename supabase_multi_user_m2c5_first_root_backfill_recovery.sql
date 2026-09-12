-- M2C.5 recovery. This is not M2C.4 standalone rollback and never deletes the
-- Auth account or migration evidence. It is allowed only before M2C.6 or any
-- UUID-dependent writer. Requires xiaoc.m2c5.run_id.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
select pg_advisory_xact_lock(hashtextextended('xiaoc:multi-user:m2c5:first-root-backfill',0));
lock table public.conversations,public.messages,public.memories,
  public.conversation_summary,public.user_state in share row exclusive mode;

do $m2c5_recovery_guard$
declare v_run uuid:=current_setting('xiaoc.m2c5.run_id')::uuid;
begin
  if not exists (select 1 from public.multi_user_migration_runs where run_id=v_run and status='committed') then
    raise exception 'M2C5_RECOVERY_RUN_NOT_COMMITTED';
  end if;
  if exists (select 1 from public.multi_user_m2c5_row_manifest m where m.run_id=v_run and m.prior_user_uuid is not null) then
    raise exception 'M2C5_RECOVERY_NON_NULL_PRIOR_OWNER';
  end if;
  if exists (
    select 1
    from public.multi_user_m2c5_row_manifest m
    left join (
      select 'conversations' source_table,conversation_id row_key,user_uuid from public.conversations
      union all select 'messages',id::text,user_uuid from public.messages
      union all select 'memories',id::text,user_uuid from public.memories
      union all select 'conversation_summary',id::text,user_uuid from public.conversation_summary
      union all select 'user_state',user_id,user_uuid from public.user_state
    ) current_rows using (source_table,row_key)
    where m.run_id=v_run
      and (current_rows.row_key is null or current_rows.user_uuid is distinct from m.assigned_user_uuid)
  ) then
    raise exception 'M2C5_RECOVERY_MANIFEST_ROW_DRIFT';
  end if;
  if exists (
    select 1
    from (
      select 'conversations' source_table,conversation_id row_key,user_uuid from public.conversations where user_uuid is not null
      union all select 'messages',id::text,user_uuid from public.messages where user_uuid is not null
      union all select 'memories',id::text,user_uuid from public.memories where user_uuid is not null
      union all select 'conversation_summary',id::text,user_uuid from public.conversation_summary where user_uuid is not null
      union all select 'user_state',user_id,user_uuid from public.user_state where user_uuid is not null
    ) current_rows
    left join public.multi_user_m2c5_row_manifest m
      on m.run_id=v_run and m.source_table=current_rows.source_table and m.row_key=current_rows.row_key
    where m.row_key is null or current_rows.user_uuid is distinct from m.assigned_user_uuid
  ) then
    raise exception 'M2C5_RECOVERY_UNMANIFESTED_UUID_ROW';
  end if;
end
$m2c5_recovery_guard$;

update public.multi_user_migration_runs set status='recovery_started'
where run_id=current_setting('xiaoc.m2c5.run_id')::uuid;
update public.conversations t set user_uuid=m.prior_user_uuid from public.multi_user_m2c5_row_manifest m where m.run_id=current_setting('xiaoc.m2c5.run_id')::uuid and m.source_table='conversations' and t.conversation_id=m.row_key and t.user_uuid=m.assigned_user_uuid;
update public.messages t set user_uuid=m.prior_user_uuid from public.multi_user_m2c5_row_manifest m where m.run_id=current_setting('xiaoc.m2c5.run_id')::uuid and m.source_table='messages' and t.id=m.row_key::uuid and t.user_uuid=m.assigned_user_uuid;
update public.memories t set user_uuid=m.prior_user_uuid from public.multi_user_m2c5_row_manifest m where m.run_id=current_setting('xiaoc.m2c5.run_id')::uuid and m.source_table='memories' and t.id=m.row_key::uuid and t.user_uuid=m.assigned_user_uuid;
update public.conversation_summary t set user_uuid=m.prior_user_uuid from public.multi_user_m2c5_row_manifest m where m.run_id=current_setting('xiaoc.m2c5.run_id')::uuid and m.source_table='conversation_summary' and t.id=m.row_key::bigint and t.user_uuid=m.assigned_user_uuid;
update public.user_state t set user_uuid=m.prior_user_uuid from public.multi_user_m2c5_row_manifest m where m.run_id=current_setting('xiaoc.m2c5.run_id')::uuid and m.source_table='user_state' and t.user_id=m.row_key and t.user_uuid=m.assigned_user_uuid;

-- Keep the root and Auth account. This preserves audit referential integrity and
-- permanently prevents reuse of the M2C.4 empty-foundation rollback contract.
update public.companion_instances set lifecycle_status='suspended',updated_at=now()
where user_id=(select target_user_id from public.multi_user_migration_runs where run_id=current_setting('xiaoc.m2c5.run_id')::uuid);
update public.multi_user_migration_runs set status='recovered',recovered_at=now()
where run_id=current_setting('xiaoc.m2c5.run_id')::uuid;
commit;

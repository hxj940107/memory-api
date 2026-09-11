-- Read-only M2C.5 validation. Requires xiaoc.m2c5.run_id and
-- xiaoc.m2c5.target_user_uuid to be set for this transaction.
begin transaction read only;

select 'run committed' check_name,
       count(*)=1 and bool_and(status='committed') pass
from public.multi_user_migration_runs
where run_id=current_setting('xiaoc.m2c5.run_id')::uuid
union all
select 'one active Auth-backed companion root',
       count(*)=1 and bool_and(ci.lifecycle_status='active')
from public.companion_instances ci join auth.users au on au.id=ci.user_id
where ci.user_id=current_setting('xiaoc.m2c5.target_user_uuid')::uuid
union all
select 'table audit is complete and reconciled',
       count(*)=5 and bool_and(before_count=eligible_count+quarantined_count
         and eligible_count=updated_count and quarantined_count=remaining_count)
from public.multi_user_m2c5_table_audit
where run_id=current_setting('xiaoc.m2c5.run_id')::uuid
union all
select 'manifest rows have only approved owner',
       not exists (select 1 from public.multi_user_m2c5_row_manifest
         where run_id=current_setting('xiaoc.m2c5.run_id')::uuid
           and (prior_user_uuid is not null or assigned_user_uuid<>current_setting('xiaoc.m2c5.target_user_uuid')::uuid))
union all
select 'user cohort conversations backfilled',
       not exists (select 1 from public.conversations where user_id='user' and user_uuid is distinct from current_setting('xiaoc.m2c5.target_user_uuid')::uuid)
union all
select 'user cohort messages backfilled with same-owner parent',
       not exists (select 1 from public.messages m where m.user_id='user' and (m.user_uuid is distinct from current_setting('xiaoc.m2c5.target_user_uuid')::uuid or not exists (select 1 from public.conversations c where c.conversation_id=m.conversation_id and c.user_uuid=m.user_uuid)))
union all
select 'user cohort memories and state backfilled',
       not exists (select 1 from public.memories where user_id='user' and user_uuid is distinct from current_setting('xiaoc.m2c5.target_user_uuid')::uuid)
       and not exists (select 1 from public.user_state where user_id='user' and user_uuid is distinct from current_setting('xiaoc.m2c5.target_user_uuid')::uuid)
union all
select 'Summary ownership requires approved parent',
       not exists (select 1 from public.conversation_summary s where s.user_uuid is not null and not exists (select 1 from public.conversations c where c.conversation_id=s.conversation_id and c.user_uuid=s.user_uuid))
       and (select encode(extensions.digest(coalesce(string_agg(
         concat_ws('|',id::text,conversation_id,coalesce(core_memory_snapshot_hash,''),
           coalesce(last_summarized_at::text,''),coalesce(core_memory_snapshot_created_at::text,''),
           coalesce(array_to_string(core_memory_source_bucket_ids,','),'')), E'\n' order by id),''),'sha256'),'hex')
         from public.conversation_summary)
       = (select lower(summary_metadata_digest) from public.multi_user_migration_runs where run_id=current_setting('xiaoc.m2c5.run_id')::uuid)
union all
select 'small_c and test remain unassigned',
       not exists (select 1 from public.conversations where user_id in ('small_c','test') and user_uuid is not null)
       and not exists (select 1 from public.messages where user_id in ('small_c','test') and user_uuid is not null)
       and not exists (select 1 from public.memories where user_id in ('small_c','test') and user_uuid is not null)
       and not exists (select 1 from public.user_state where user_id in ('small_c','test') and user_uuid is not null)
union all
select 'all remaining Core rows are quarantined',
       (select count(*) from public.multi_user_quarantine_registry where run_id=current_setting('xiaoc.m2c5.run_id')::uuid)
       = (select sum(remaining_count) from public.multi_user_m2c5_table_audit where run_id=current_setting('xiaoc.m2c5.run_id')::uuid)
union all
select 'ordinary roles cannot read migration registries',
       not has_table_privilege('anon','public.multi_user_migration_runs','SELECT')
       and not has_table_privilege('authenticated','public.multi_user_migration_runs','SELECT')
       and not has_table_privilege('anon','public.multi_user_m2c5_row_manifest','SELECT')
       and not has_table_privilege('authenticated','public.multi_user_m2c5_row_manifest','SELECT')
union all
select 'legacy columns and Core RLS remain compatible',
       (select count(*) from information_schema.columns where table_schema='public' and table_name in ('conversations','messages','memories','user_state') and column_name='user_id')=4
       and (select count(*) filter(where not c.relrowsecurity and not c.relforcerowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('conversations','messages','memories','conversation_summary','user_state'))=5;

rollback;

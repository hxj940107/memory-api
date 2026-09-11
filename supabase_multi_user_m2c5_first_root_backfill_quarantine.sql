-- Multi-user M2C.5: first companion root plus manifest-bounded Core backfill.
-- PREPARED ONLY. Production execution requires a separate read-only preflight,
-- frozen inputs, write/worker drain, and explicit approval.
-- Required transaction-local settings:
--   xiaoc.m2c5.run_id              UUID generated and frozen before apply
--   xiaoc.m2c5.target_user_uuid     independently verified auth.users.id
--   xiaoc.m2c5.mapping_version      immutable reviewed registry version
--   xiaoc.m2c5.mapping_digest       SHA-256 of the privacy-safe mapping manifest
--   xiaoc.m2c5.summary_metadata_digest  SHA-256 excluding Summary/private text
--   xiaoc.m2c5.expected_counts      JSON object keyed by the five Core tables

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

select pg_advisory_xact_lock(hashtextextended('xiaoc:multi-user:m2c5:first-root-backfill', 0));

create temporary table m2c5_config on commit drop as
select current_setting('xiaoc.m2c5.run_id', true)::uuid as run_id,
       current_setting('xiaoc.m2c5.target_user_uuid', true)::uuid as target_user_id,
       nullif(current_setting('xiaoc.m2c5.mapping_version', true), '') as mapping_version,
       nullif(current_setting('xiaoc.m2c5.mapping_digest', true), '') as mapping_digest,
       nullif(current_setting('xiaoc.m2c5.summary_metadata_digest', true), '') as summary_metadata_digest,
       current_setting('xiaoc.m2c5.expected_counts', true)::jsonb as expected_counts;

do $m2c5_input_guard$
begin
  if exists (
    select 1 from m2c5_config
    where run_id is null or target_user_id is null or mapping_version is null
       or mapping_digest !~ '^[0-9A-Fa-f]{64}$'
       or summary_metadata_digest !~ '^[0-9A-Fa-f]{64}$'
       or expected_counts is null
  ) then
    raise exception 'M2C5_REQUIRED_INPUT_MISSING_OR_INVALID';
  end if;
  if (select count(*) from jsonb_object_keys((select expected_counts from m2c5_config)))<>5
     or exists (
       select 1 from unnest(array['conversations','messages','memories','conversation_summary','user_state']) t(name)
       where not ((select expected_counts from m2c5_config) ? t.name)
          or ((select expected_counts from m2c5_config)->t.name->>'before') is null
          or ((select expected_counts from m2c5_config)->t.name->>'eligible') is null
          or ((select expected_counts from m2c5_config)->t.name->>'quarantined') is null
     ) then
    raise exception 'M2C5_EXPECTED_COUNTS_INCOMPLETE';
  end if;
end
$m2c5_input_guard$;

do $m2c5_state_guard$
declare
  v_target uuid := (select target_user_id from m2c5_config);
begin
  if not exists (select 1 from auth.users where id=v_target) then
    raise exception 'M2C5_VERIFIED_AUTH_USER_MISSING';
  end if;
  if to_regclass('public.companion_instances') is null then
    raise exception 'M2C5_M2C4_FOUNDATION_MISSING';
  end if;
  if exists (select 1 from public.companion_instances)
     or exists (select 1 from public.conversations where user_uuid is not null)
     or exists (select 1 from public.messages where user_uuid is not null)
     or exists (select 1 from public.memories where user_uuid is not null)
     or exists (select 1 from public.conversation_summary where user_uuid is not null)
     or exists (select 1 from public.user_state where user_uuid is not null) then
    raise exception 'M2C5_FOUNDATION_NOT_EMPTY';
  end if;
  if exists (
    select 1 from (
      select user_id from public.conversations
      union all select user_id from public.messages
      union all select user_id from public.memories
      union all select user_id from public.user_state
    ) owners where user_id is null or user_id not in ('user','small_c','test')
  ) then
    raise exception 'M2C5_UNKNOWN_OR_NULL_CORE_OWNER';
  end if;
  if exists (
    select 1 from public.messages m
    where m.user_id='user'
      and not exists (
        select 1 from public.conversations c
        where c.conversation_id=m.conversation_id and c.user_id='user'
      )
  ) then
    raise exception 'M2C5_USER_MESSAGE_PARENT_MISSING_OR_CROSS_OWNER';
  end if;
end
$m2c5_state_guard$;

create table public.multi_user_migration_runs (
  run_id uuid primary key,
  checkpoint text not null check (checkpoint='M2C.5'),
  target_user_id uuid not null references public.companion_instances(user_id)
    on update restrict on delete restrict,
  mapping_version text not null,
  mapping_digest text not null check (mapping_digest ~ '^[0-9A-Fa-f]{64}$'),
  summary_metadata_digest text not null check (summary_metadata_digest ~ '^[0-9A-Fa-f]{64}$'),
  status text not null check (status in ('started','committed','recovery_started','recovered')),
  started_at timestamptz not null default now(),
  committed_at timestamptz,
  recovered_at timestamptz
);

create table public.multi_user_legacy_owner_registry (
  mapping_version text not null,
  cohort_key text not null,
  legacy_owner text not null,
  classification text not null check (classification in ('private-current','historical-valid','test-prototype','stale-import','unknown')),
  disposition text not null check (disposition in ('approved-target','quarantine')),
  target_user_id uuid references auth.users(id) on update restrict on delete restrict,
  evidence_digest text not null check (evidence_digest ~ '^[0-9A-Fa-f]{64}$'),
  blocks_cutover boolean not null,
  created_at timestamptz not null default now(),
  primary key (mapping_version,cohort_key),
  unique (mapping_version,legacy_owner),
  check ((disposition='approved-target' and target_user_id is not null and not blocks_cutover)
      or (disposition='quarantine' and target_user_id is null and blocks_cutover))
);

create table public.multi_user_m2c5_row_manifest (
  run_id uuid not null references public.multi_user_migration_runs(run_id) on delete restrict,
  source_table text not null check (source_table in ('conversations','messages','memories','conversation_summary','user_state')),
  row_key text not null,
  prior_user_uuid uuid,
  assigned_user_uuid uuid not null,
  primary key (run_id,source_table,row_key)
);

create table public.multi_user_quarantine_registry (
  run_id uuid not null references public.multi_user_migration_runs(run_id) on delete restrict,
  source_table text not null,
  row_key_digest text not null check (row_key_digest ~ '^[0-9a-f]{64}$'),
  legacy_cohort text,
  reason text not null check (reason in ('historical-valid-unmapped','test-prototype','summary-orphan','nonapproved-summary-parent')),
  created_at timestamptz not null default now(),
  primary key (run_id,source_table,row_key_digest)
);

create table public.multi_user_m2c5_table_audit (
  run_id uuid not null references public.multi_user_migration_runs(run_id) on delete restrict,
  source_table text not null,
  before_count bigint not null,
  eligible_count bigint not null,
  updated_count bigint not null,
  quarantined_count bigint not null,
  remaining_count bigint not null,
  eligible_key_digest text not null,
  remaining_key_digest text not null,
  primary key (run_id,source_table),
  check (before_count=eligible_count+quarantined_count),
  check (updated_count=eligible_count),
  check (remaining_count=quarantined_count)
);

alter table public.multi_user_migration_runs enable row level security;
alter table public.multi_user_legacy_owner_registry enable row level security;
alter table public.multi_user_m2c5_row_manifest enable row level security;
alter table public.multi_user_quarantine_registry enable row level security;
alter table public.multi_user_m2c5_table_audit enable row level security;
revoke all on table public.multi_user_migration_runs,public.multi_user_legacy_owner_registry,
  public.multi_user_m2c5_row_manifest,public.multi_user_quarantine_registry,
  public.multi_user_m2c5_table_audit from public,anon,authenticated;
grant select,insert,update,delete on table public.multi_user_migration_runs,
  public.multi_user_legacy_owner_registry,public.multi_user_m2c5_row_manifest,
  public.multi_user_quarantine_registry,public.multi_user_m2c5_table_audit to service_role;

insert into public.companion_instances(user_id,lifecycle_status,foundation_version)
select target_user_id,'provisioning',1 from m2c5_config;

insert into public.multi_user_migration_runs(run_id,checkpoint,target_user_id,mapping_version,mapping_digest,summary_metadata_digest,status)
select run_id,'M2C.5',target_user_id,mapping_version,mapping_digest,summary_metadata_digest,'started' from m2c5_config;

insert into public.multi_user_legacy_owner_registry
  (mapping_version,cohort_key,legacy_owner,classification,disposition,target_user_id,evidence_digest,blocks_cutover)
select mapping_version,'private-current:user','user','private-current','approved-target',target_user_id,mapping_digest,false from m2c5_config
union all
select mapping_version,'historical-valid:small_c','small_c','historical-valid','quarantine',null,mapping_digest,true from m2c5_config
union all
select mapping_version,'test-prototype:test','test','test-prototype','quarantine',null,mapping_digest,true from m2c5_config;

-- Freeze the exact eligible row set before any bridge update. Summary ownership
-- is derived only from one existing approved-owner conversation.
insert into public.multi_user_m2c5_row_manifest(run_id,source_table,row_key,prior_user_uuid,assigned_user_uuid)
select cfg.run_id,'conversations',c.conversation_id,c.user_uuid,cfg.target_user_id
from public.conversations c cross join m2c5_config cfg where c.user_id='user'
union all
select cfg.run_id,'messages',m.id::text,m.user_uuid,cfg.target_user_id
from public.messages m cross join m2c5_config cfg
where m.user_id='user' and exists (select 1 from public.conversations c where c.conversation_id=m.conversation_id and c.user_id='user')
union all
select cfg.run_id,'memories',m.id::text,m.user_uuid,cfg.target_user_id
from public.memories m cross join m2c5_config cfg where m.user_id='user'
union all
select cfg.run_id,'conversation_summary',s.id::text,s.user_uuid,cfg.target_user_id
from public.conversation_summary s cross join m2c5_config cfg
where (select count(*) from public.conversations c where c.conversation_id=s.conversation_id and c.user_id='user')=1
  and not exists (select 1 from public.conversations c where c.conversation_id=s.conversation_id and c.user_id<>'user')
union all
select cfg.run_id,'user_state',s.user_id,s.user_uuid,cfg.target_user_id
from public.user_state s cross join m2c5_config cfg where s.user_id='user';

-- Quarantine every pre-existing Core row outside the approved manifest. Only a
-- one-way row-key digest is stored; original rows and legacy owners are untouched.
insert into public.multi_user_quarantine_registry(run_id,source_table,row_key_digest,legacy_cohort,reason)
select cfg.run_id,x.source_table,
       encode(extensions.digest(x.source_table||':'||x.row_key,'sha256'),'hex'),
       x.legacy_owner,
       case when x.source_table='conversation_summary' and x.parent_count=0 then 'summary-orphan'
            when x.source_table='conversation_summary' then 'nonapproved-summary-parent'
            when x.legacy_owner='small_c' then 'historical-valid-unmapped'
            else 'test-prototype' end
from m2c5_config cfg
cross join lateral (
  select 'conversations' source_table,c.conversation_id row_key,c.user_id legacy_owner,null::bigint parent_count from public.conversations c where c.user_id<>'user'
  union all select 'messages',m.id::text,m.user_id,null from public.messages m where m.user_id<>'user'
  union all select 'memories',m.id::text,m.user_id,null from public.memories m where m.user_id<>'user'
  union all select 'user_state',s.user_id,s.user_id,null from public.user_state s where s.user_id<>'user'
  union all select 'conversation_summary',s.id::text,null,(select count(*) from public.conversations c where c.conversation_id=s.conversation_id)
    from public.conversation_summary s
    where not exists (select 1 from public.multi_user_m2c5_row_manifest mf where mf.run_id=cfg.run_id and mf.source_table='conversation_summary' and mf.row_key=s.id::text)
) x;

update public.conversations t set user_uuid=m.assigned_user_uuid
from public.multi_user_m2c5_row_manifest m join m2c5_config cfg on cfg.run_id=m.run_id
where m.source_table='conversations' and t.conversation_id=m.row_key and t.user_uuid is not distinct from m.prior_user_uuid;
update public.messages t set user_uuid=m.assigned_user_uuid
from public.multi_user_m2c5_row_manifest m join m2c5_config cfg on cfg.run_id=m.run_id
where m.source_table='messages' and t.id=m.row_key::uuid and t.user_uuid is not distinct from m.prior_user_uuid;
update public.memories t set user_uuid=m.assigned_user_uuid
from public.multi_user_m2c5_row_manifest m join m2c5_config cfg on cfg.run_id=m.run_id
where m.source_table='memories' and t.id=m.row_key::uuid and t.user_uuid is not distinct from m.prior_user_uuid;
update public.conversation_summary t set user_uuid=m.assigned_user_uuid
from public.multi_user_m2c5_row_manifest m join m2c5_config cfg on cfg.run_id=m.run_id
where m.source_table='conversation_summary' and t.id=m.row_key::bigint and t.user_uuid is not distinct from m.prior_user_uuid;
update public.user_state t set user_uuid=m.assigned_user_uuid
from public.multi_user_m2c5_row_manifest m join m2c5_config cfg on cfg.run_id=m.run_id
where m.source_table='user_state' and t.user_id=m.row_key and t.user_uuid is not distinct from m.prior_user_uuid;

-- The audit is populated from the frozen manifest and post-update state. The
-- preflight must freeze expected_counts with the same five table names.
insert into public.multi_user_m2c5_table_audit
  (run_id,source_table,before_count,eligible_count,updated_count,quarantined_count,remaining_count,eligible_key_digest,remaining_key_digest)
select cfg.run_id,t.source_table,t.before_count,t.eligible_count,t.updated_count,
       t.before_count-t.eligible_count,t.remaining_count,t.eligible_digest,t.remaining_digest
from m2c5_config cfg
cross join lateral (
  select 'conversations' source_table,count(*) before_count,count(*) filter(where user_uuid=cfg.target_user_id) eligible_count,count(*) filter(where user_uuid=cfg.target_user_id) updated_count,count(*) filter(where user_uuid is null) remaining_count,
    md5(coalesce(string_agg(conversation_id,',' order by conversation_id) filter(where user_uuid=cfg.target_user_id),'')) eligible_digest,
    md5(coalesce(string_agg(conversation_id,',' order by conversation_id) filter(where user_uuid is null),'')) remaining_digest from public.conversations
  union all select 'messages',count(*),count(*) filter(where user_uuid=cfg.target_user_id),count(*) filter(where user_uuid=cfg.target_user_id),count(*) filter(where user_uuid is null),md5(coalesce(string_agg(id::text,',' order by id::text) filter(where user_uuid=cfg.target_user_id),'')),md5(coalesce(string_agg(id::text,',' order by id::text) filter(where user_uuid is null),'')) from public.messages
  union all select 'memories',count(*),count(*) filter(where user_uuid=cfg.target_user_id),count(*) filter(where user_uuid=cfg.target_user_id),count(*) filter(where user_uuid is null),md5(coalesce(string_agg(id::text,',' order by id::text) filter(where user_uuid=cfg.target_user_id),'')),md5(coalesce(string_agg(id::text,',' order by id::text) filter(where user_uuid is null),'')) from public.memories
  union all select 'conversation_summary',count(*),count(*) filter(where user_uuid=cfg.target_user_id),count(*) filter(where user_uuid=cfg.target_user_id),count(*) filter(where user_uuid is null),md5(coalesce(string_agg(id::text,',' order by id::text) filter(where user_uuid=cfg.target_user_id),'')),md5(coalesce(string_agg(id::text,',' order by id::text) filter(where user_uuid is null),'')) from public.conversation_summary
  union all select 'user_state',count(*),count(*) filter(where user_uuid=cfg.target_user_id),count(*) filter(where user_uuid=cfg.target_user_id),count(*) filter(where user_uuid is null),md5(coalesce(string_agg(user_id,',' order by user_id) filter(where user_uuid=cfg.target_user_id),'')),md5(coalesce(string_agg(user_id,',' order by user_id) filter(where user_uuid is null),'')) from public.user_state
) t;

do $m2c5_reconcile$
declare
  v_expected jsonb := (select expected_counts from m2c5_config);
begin
  if exists (
    select 1 from public.multi_user_m2c5_table_audit a join m2c5_config cfg on cfg.run_id=a.run_id
    where a.before_count is distinct from (v_expected->a.source_table->>'before')::bigint
       or a.eligible_count is distinct from (v_expected->a.source_table->>'eligible')::bigint
       or a.updated_count is distinct from (v_expected->a.source_table->>'eligible')::bigint
       or a.quarantined_count is distinct from (v_expected->a.source_table->>'quarantined')::bigint
       or a.remaining_count is distinct from (v_expected->a.source_table->>'quarantined')::bigint
  ) then
    raise exception 'M2C5_COUNT_RECONCILIATION_FAILED';
  end if;
  if (select encode(extensions.digest(coalesce(string_agg(
       concat_ws('|',id::text,conversation_id,coalesce(core_memory_snapshot_hash,''),
         coalesce(last_summarized_at::text,''),coalesce(core_memory_snapshot_created_at::text,''),
         coalesce(array_to_string(core_memory_source_bucket_ids,','),'')), E'\n' order by id),''),'sha256'),'hex')
      from public.conversation_summary)
     <> lower((select summary_metadata_digest from m2c5_config)) then
    raise exception 'M2C5_SUMMARY_CORE_METADATA_DIGEST_CHANGED';
  end if;
end
$m2c5_reconcile$;

update public.companion_instances set lifecycle_status='active',updated_at=now()
where user_id=(select target_user_id from m2c5_config);
update public.multi_user_migration_runs set status='committed',committed_at=now()
where run_id=(select run_id from m2c5_config);

commit;

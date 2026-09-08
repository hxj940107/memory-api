-- XiaoC Memory Engine M2B schema foundation.
-- Additive only: does not read, copy, update, or delete existing Memory data.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists vector with schema extensions;

create table public.memory_operations (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  operation_type text not null check (btrim(operation_type) <> ''),
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  actor_type text not null check (actor_type in ('system', 'user', 'migration')),
  policy_version text not null check (btrim(policy_version) <> ''),
  result_status text not null default 'started'
    check (result_status in ('started', 'success', 'failed', 'cancelled')),
  reason_code text,
  affected_memory_ids uuid[] not null default '{}'::uuid[],
  before_state jsonb,
  after_state jsonb,
  compensates_operation_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, id),
  unique (user_id, operation_type, idempotency_key),
  foreign key (user_id, compensates_operation_id)
    references public.memory_operations (user_id, id),
  check (
    (result_status = 'started' and completed_at is null)
    or (result_status in ('success', 'failed', 'cancelled') and completed_at is not null)
  )
);

create table public.memory_items (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  canonical_content text not null check (btrim(canonical_content) <> ''),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  origin_system text not null check (origin_system in ('xiaoc_native', 'ombre_legacy')),
  memory_class text not null check (memory_class in ('observation', 'stable')),
  category text not null check (btrim(category) <> ''),
  provenance_status text not null check (
    provenance_status in ('verified_user', 'derived_verified', 'manual_confirmed', 'legacy_unverified')
  ),
  lifecycle_status text not null default 'active' check (
    lifecycle_status in ('active', 'superseded', 'archived', 'deleted')
  ),
  retrieval_tier text check (
    retrieval_tier is null
    or retrieval_tier in ('active_legacy', 'low_authority', 'shadow_only', 'quarantined', 'disabled')
  ),
  authority_tier text not null check (
    authority_tier in ('native_verified', 'legacy_limited', 'none')
  ),
  authority_policy_version text not null check (btrim(authority_policy_version) <> ''),
  claim_key text check (claim_key is null or btrim(claim_key) <> ''),
  importance smallint check (importance between 0 and 10),
  confidence numeric(4,3) check (confidence between 0 and 1),
  event_time timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  resolved_at timestamptz,
  superseded_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  capture_policy_version text not null check (btrim(capture_policy_version) <> ''),
  revision bigint not null default 1 check (revision > 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  check (valid_until is null or valid_from is null or valid_until >= valid_from),
  check (lifecycle_status <> 'superseded' or superseded_at is not null),
  check (lifecycle_status <> 'archived' or archived_at is not null),
  check (lifecycle_status <> 'deleted' or deleted_at is not null),
  check (origin_system <> 'ombre_legacy' or provenance_status = 'legacy_unverified'),
  check (retrieval_tier is null or provenance_status = 'legacy_unverified'),
  check (provenance_status = 'legacy_unverified' or retrieval_tier is null),
  check (
    (retrieval_tier in ('active_legacy', 'low_authority') and authority_tier = 'legacy_limited')
    or (retrieval_tier in ('shadow_only', 'quarantined', 'disabled') and authority_tier = 'none')
    or (retrieval_tier is null and authority_tier in ('native_verified', 'none'))
  ),
  check (not (metadata ?| array[
    'user_id', 'canonical_content', 'content_hash', 'source_locator_key',
    'legacy_external_id', 'from_memory_id', 'to_memory_id', 'relation_type'
  ]))
);

create table public.memory_import_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  source_system text not null check (btrim(source_system) <> ''),
  source_archive_sha256 text not null check (source_archive_sha256 ~ '^[0-9a-f]{64}$'),
  importer_version text not null check (btrim(importer_version) <> ''),
  legacy_policy_version text not null check (btrim(legacy_policy_version) <> ''),
  run_status text not null default 'planned'
    check (run_status in ('planned', 'applying', 'complete', 'failed', 'disabled')),
  source_file_count integer not null default 0 check (source_file_count >= 0),
  planned_count integer not null default 0 check (planned_count >= 0),
  imported_count integer not null default 0 check (imported_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  tier_statistics jsonb not null default '{}'::jsonb check (jsonb_typeof(tier_statistics) = 'object'),
  validation_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(validation_summary) = 'object'),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, id),
  unique (
    user_id, source_system, source_archive_sha256,
    importer_version, legacy_policy_version
  )
);

create table public.memory_provenance (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  memory_id uuid not null,
  source_kind text not null check (source_kind in ('message', 'manual_user')),
  source_locator_key text not null check (btrim(source_locator_key) <> ''),
  source_message_id uuid,
  source_operation_id uuid,
  source_conversation_id text,
  source_role text not null check (source_role = 'user'),
  evidence_text text not null check (btrim(evidence_text) <> ''),
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  evidence_type text not null check (
    evidence_type in ('assertion', 'confirmation', 'correction', 'question', 'other')
  ),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, memory_id, source_kind, source_locator_key, evidence_hash),
  foreign key (user_id, memory_id)
    references public.memory_items (user_id, id),
  foreign key (source_message_id)
    references public.messages (id),
  foreign key (user_id, source_operation_id)
    references public.memory_operations (user_id, id),
  check (
    (source_kind = 'message'
      and source_message_id is not null
      and source_operation_id is null
      and source_locator_key = 'message:' || source_message_id::text)
    or
    (source_kind = 'manual_user'
      and source_message_id is null
      and source_operation_id is not null
      and source_locator_key = 'manual:' || source_operation_id::text)
  )
);

create table public.memory_relations (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  from_memory_id uuid not null,
  to_memory_id uuid not null,
  relation_type text not null check (
    relation_type in ('supersedes', 'consolidates', 'contradicts', 'duplicates', 'revalidates')
  ),
  operation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, from_memory_id, to_memory_id, relation_type),
  foreign key (user_id, from_memory_id)
    references public.memory_items (user_id, id),
  foreign key (user_id, to_memory_id)
    references public.memory_items (user_id, id),
  foreign key (user_id, operation_id)
    references public.memory_operations (user_id, id),
  check (from_memory_id <> to_memory_id),
  check (relation_type <> 'duplicates' or from_memory_id < to_memory_id)
);

create table public.memory_embeddings (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  memory_id uuid not null,
  provider text not null check (btrim(provider) <> ''),
  model text not null check (btrim(model) <> ''),
  embedding_version text not null check (btrim(embedding_version) <> ''),
  preprocessor_version text not null check (btrim(preprocessor_version) <> ''),
  dimensions integer not null check (dimensions > 0),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  embedding extensions.vector not null,
  rollout_status text not null check (rollout_status in ('active', 'shadow', 'retired', 'stale')),
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (
    user_id, memory_id, provider, model,
    embedding_version, preprocessor_version, content_hash
  ),
  foreign key (user_id, memory_id)
    references public.memory_items (user_id, id),
  check (extensions.vector_dims(embedding) = dimensions)
);

create unique index memory_embeddings_one_active_idx
  on public.memory_embeddings (user_id, memory_id)
  where rollout_status = 'active';

create table public.memory_pins (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  memory_id uuid not null,
  scope text not null check (scope = 'core'),
  ordinal integer not null check (ordinal >= 0),
  pin_status text not null check (pin_status in ('active', 'inactive')),
  pinned_by text not null check (pinned_by in ('user', 'migration')),
  operation_id uuid not null,
  pinned_at timestamptz not null,
  unpinned_at timestamptz,
  unique (user_id, id),
  unique (user_id, memory_id, scope),
  foreign key (user_id, memory_id)
    references public.memory_items (user_id, id),
  foreign key (user_id, operation_id)
    references public.memory_operations (user_id, id),
  check (
    (pin_status = 'active' and unpinned_at is null)
    or (pin_status = 'inactive' and unpinned_at is not null)
  )
);

create unique index memory_pins_active_ordinal_idx
  on public.memory_pins (user_id, scope, ordinal)
  where pin_status = 'active';

create table public.legacy_memory_map (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  import_run_id uuid not null,
  memory_id uuid not null,
  source_system text not null check (btrim(source_system) <> ''),
  legacy_external_id text not null check (btrim(legacy_external_id) <> ''),
  original_relative_path text not null check (
    btrim(original_relative_path) <> ''
    and original_relative_path !~ '(^|/)\.\.(/|$)'
    and original_relative_path !~ '^/'
  ),
  original_content text not null,
  original_content_hash text not null check (original_content_hash ~ '^[0-9a-f]{64}$'),
  original_metadata jsonb not null default '{}'::jsonb,
  original_lifecycle_hints jsonb not null default '{}'::jsonb,
  legacy_pin_candidate boolean not null default false,
  original_archive_state text,
  original_created_at timestamptz,
  original_last_active_at timestamptz,
  original_activation_count integer check (original_activation_count >= 0),
  legacy_policy_version text not null check (btrim(legacy_policy_version) <> ''),
  initial_retrieval_tier text not null check (
    initial_retrieval_tier in ('active_legacy', 'low_authority', 'shadow_only', 'quarantined', 'disabled')
  ),
  legacy_duplicate_cluster_id text check (
    legacy_duplicate_cluster_id is null or btrim(legacy_duplicate_cluster_id) <> ''
  ),
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, source_system, legacy_external_id),
  unique (user_id, import_run_id, original_relative_path),
  foreign key (user_id, import_run_id)
    references public.memory_import_runs (user_id, id),
  foreign key (user_id, memory_id)
    references public.memory_items (user_id, id),
  check (jsonb_typeof(original_metadata) = 'object'),
  check (jsonb_typeof(original_lifecycle_hints) = 'object')
);

-- Minimal indexes for declared access paths.
create index memory_items_eligibility_idx
  on public.memory_items (user_id, lifecycle_status, retrieval_tier, created_at desc);
create index memory_items_claim_idx
  on public.memory_items (user_id, claim_key, lifecycle_status, valid_from desc, created_at desc)
  where claim_key is not null;
create index memory_items_created_idx
  on public.memory_items (user_id, created_at desc);
create index memory_items_valid_until_idx
  on public.memory_items (user_id, valid_until)
  where valid_until is not null and lifecycle_status = 'active';
create index memory_provenance_message_idx
  on public.memory_provenance (user_id, source_message_id)
  where source_message_id is not null;
create index memory_provenance_memory_idx
  on public.memory_provenance (user_id, memory_id);
create index memory_relations_from_idx
  on public.memory_relations (user_id, from_memory_id, relation_type);
create index memory_relations_to_idx
  on public.memory_relations (user_id, to_memory_id, relation_type);
create index memory_embeddings_lookup_idx
  on public.memory_embeddings (user_id, memory_id, rollout_status);
create index memory_embeddings_version_idx
  on public.memory_embeddings (user_id, provider, model, embedding_version, rollout_status);
create index memory_pins_lookup_idx
  on public.memory_pins (user_id, scope, pin_status, ordinal);
create index memory_operations_created_idx
  on public.memory_operations (user_id, created_at desc);
create index memory_operations_status_idx
  on public.memory_operations (user_id, result_status, created_at desc);
create index legacy_memory_cluster_idx
  on public.legacy_memory_map (user_id, legacy_duplicate_cluster_id)
  where legacy_duplicate_cluster_id is not null;

-- Central immutable and controlled-transition guards.
create or replace function public.xiaoc_memory_guard_item_immutable()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if row(
    new.id, new.user_id, new.canonical_content, new.content_hash,
    new.origin_system, new.memory_class, new.category, new.provenance_status,
    new.claim_key, new.confidence, new.event_time, new.valid_from,
    new.valid_until, new.capture_policy_version, new.created_at
  ) is distinct from row(
    old.id, old.user_id, old.canonical_content, old.content_hash,
    old.origin_system, old.memory_class, old.category, old.provenance_status,
    old.claim_key, old.confidence, old.event_time, old.valid_from,
    old.valid_until, old.capture_policy_version, old.created_at
  ) then
    raise exception 'immutable memory item fields cannot be changed';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'memory item revision must increment by one';
  end if;
  return new;
end;
$$;

create trigger memory_items_immutable_guard
before update on public.memory_items
for each row execute function public.xiaoc_memory_guard_item_immutable();

create or replace function public.xiaoc_memory_guard_append_only()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

create trigger memory_provenance_append_only_guard
before update or delete on public.memory_provenance
for each row execute function public.xiaoc_memory_guard_append_only();
create trigger memory_relations_append_only_guard
before update or delete on public.memory_relations
for each row execute function public.xiaoc_memory_guard_append_only();
create trigger legacy_memory_map_append_only_guard
before update or delete on public.legacy_memory_map
for each row execute function public.xiaoc_memory_guard_append_only();

create or replace function public.xiaoc_memory_guard_operation_transition()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if row(
    new.id, new.user_id, new.operation_type, new.idempotency_key,
    new.actor_type, new.policy_version, new.compensates_operation_id,
    new.created_at
  ) is distinct from row(
    old.id, old.user_id, old.operation_type, old.idempotency_key,
    old.actor_type, old.policy_version, old.compensates_operation_id,
    old.created_at
  ) then
    raise exception 'operation identity fields cannot be changed';
  end if;
  if old.result_status <> 'started' then
    raise exception 'terminal operation cannot be changed';
  end if;
  if new.result_status not in ('success', 'failed', 'cancelled') then
    raise exception 'operation may only transition from started to terminal';
  end if;
  return new;
end;
$$;

create trigger memory_operations_transition_guard
before update on public.memory_operations
for each row execute function public.xiaoc_memory_guard_operation_transition();
create trigger memory_operations_no_delete_guard
before delete on public.memory_operations
for each row execute function public.xiaoc_memory_guard_append_only();

create or replace function public.xiaoc_memory_guard_embedding_transition()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.memory_id is distinct from old.memory_id
    or new.provider is distinct from old.provider
    or new.model is distinct from old.model
    or new.embedding_version is distinct from old.embedding_version
    or new.preprocessor_version is distinct from old.preprocessor_version
    or new.dimensions is distinct from old.dimensions
    or new.content_hash is distinct from old.content_hash
    or new.embedding::text is distinct from old.embedding::text
    or new.created_at is distinct from old.created_at
  then
    raise exception 'embedding identity/vector fields cannot be changed';
  end if;
  if not (
    (old.rollout_status = 'shadow' and new.rollout_status in ('active', 'stale'))
    or (old.rollout_status = 'active' and new.rollout_status in ('retired', 'stale'))
    or (old.rollout_status = new.rollout_status)
  ) then
    raise exception 'invalid embedding lifecycle transition';
  end if;
  return new;
end;
$$;

create trigger memory_embeddings_transition_guard
before update on public.memory_embeddings
for each row execute function public.xiaoc_memory_guard_embedding_transition();
create trigger memory_embeddings_no_delete_guard
before delete on public.memory_embeddings
for each row execute function public.xiaoc_memory_guard_append_only();

-- One deferred integrity mechanism for verified native memories.
create or replace function public.xiaoc_memory_assert_verified_integrity(
  p_user_id text,
  p_memory_id uuid
)
returns void
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_status text;
begin
  select provenance_status into v_status
  from public.memory_items
  where user_id = p_user_id and id = p_memory_id;

  if not found or v_status = 'legacy_unverified' then
    return;
  end if;

  if v_status = 'verified_user' and not exists (
    select 1 from public.memory_provenance
    where user_id = p_user_id and memory_id = p_memory_id
      and source_kind = 'message' and source_role = 'user'
      and source_message_id is not null
      and source_locator_key = 'message:' || source_message_id::text
  ) then
    raise exception 'verified_user memory requires valid message provenance';
  elsif v_status = 'manual_confirmed' and not exists (
    select 1 from public.memory_provenance
    where user_id = p_user_id and memory_id = p_memory_id
      and source_kind = 'manual_user' and source_role = 'user'
      and source_operation_id is not null
      and source_locator_key = 'manual:' || source_operation_id::text
  ) then
    raise exception 'manual_confirmed memory requires valid manual provenance';
  elsif v_status = 'derived_verified' and (
    select count(distinct r.to_memory_id)
    from public.memory_relations r
    join public.memory_items source
      on source.user_id = r.user_id and source.id = r.to_memory_id
    where r.user_id = p_user_id and r.from_memory_id = p_memory_id
      and r.relation_type = 'consolidates'
      and source.origin_system = 'xiaoc_native'
      and source.provenance_status in ('verified_user', 'derived_verified', 'manual_confirmed')
      and source.lifecycle_status <> 'deleted'
  ) < 3 then
    raise exception 'derived_verified memory requires verified consolidation lineage';
  end if;
end;
$$;

create or replace function public.xiaoc_memory_deferred_integrity_trigger()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if tg_table_name = 'memory_items' then
    perform public.xiaoc_memory_assert_verified_integrity(coalesce(new.user_id, old.user_id), coalesce(new.id, old.id));
  elsif tg_table_name = 'memory_provenance' then
    perform public.xiaoc_memory_assert_verified_integrity(coalesce(new.user_id, old.user_id), coalesce(new.memory_id, old.memory_id));
  elsif tg_table_name = 'memory_relations' then
    perform public.xiaoc_memory_assert_verified_integrity(coalesce(new.user_id, old.user_id), coalesce(new.from_memory_id, old.from_memory_id));
  end if;
  return null;
end;
$$;

create constraint trigger memory_items_verified_integrity
after insert or update on public.memory_items
deferrable initially deferred
for each row execute function public.xiaoc_memory_deferred_integrity_trigger();
create constraint trigger memory_provenance_verified_integrity
after insert or update or delete on public.memory_provenance
deferrable initially deferred
for each row execute function public.xiaoc_memory_deferred_integrity_trigger();
create constraint trigger memory_relations_verified_integrity
after insert or update or delete on public.memory_relations
deferrable initially deferred
for each row execute function public.xiaoc_memory_deferred_integrity_trigger();

-- Operation helpers remain private to the protected RPCs.
create or replace function public.xiaoc_memory_finish_operation(
  p_user_id text,
  p_operation_id uuid,
  p_status text,
  p_reason_code text default null,
  p_affected_memory_ids uuid[] default '{}'::uuid[],
  p_before_state jsonb default null,
  p_after_state jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
begin
  if p_status not in ('success', 'failed', 'cancelled') then
    raise exception 'invalid terminal operation status';
  end if;
  update public.memory_operations
  set result_status = p_status,
      reason_code = p_reason_code,
      affected_memory_ids = coalesce(p_affected_memory_ids, '{}'::uuid[]),
      before_state = p_before_state,
      after_state = p_after_state,
      completed_at = now()
  where user_id = p_user_id and id = p_operation_id and result_status = 'started';
  if not found then
    raise exception 'operation not found or already terminal';
  end if;
end;
$$;

create or replace function public.xiaoc_memory_capture_verified(
  p_user_id text,
  p_source_message_id uuid,
  p_source_conversation_id text,
  p_evidence_text text,
  p_evidence_type text,
  p_canonical_content text,
  p_memory_class text,
  p_category text,
  p_claim_key text,
  p_event_time timestamptz,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_importance smallint,
  p_confidence numeric,
  p_capture_policy_version text,
  p_authority_policy_version text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_operation_id uuid;
  v_memory_id uuid;
  v_message record;
  v_content_hash text;
  v_evidence_hash text;
begin
  if p_evidence_type = 'question' then raise exception 'question-only evidence is not admissible'; end if;
  select id, user_id, conversation_id, role, content, created_at into v_message
  from public.messages where id = p_source_message_id;
  if not found or v_message.user_id <> p_user_id or v_message.role <> 'user'
     or v_message.conversation_id is distinct from p_source_conversation_id
     or position(p_evidence_text in v_message.content) = 0 then
    raise exception 'invalid or cross-user message provenance';
  end if;

  insert into public.memory_operations (
    user_id, operation_type, idempotency_key, actor_type, policy_version
  ) values (
    p_user_id, 'capture_verified', p_idempotency_key, 'system', p_capture_policy_version
  ) on conflict (user_id, operation_type, idempotency_key) do nothing
  returning id into v_operation_id;
  if v_operation_id is null then
    select (affected_memory_ids)[1] into v_memory_id from public.memory_operations
    where user_id = p_user_id and operation_type = 'capture_verified'
      and idempotency_key = p_idempotency_key and result_status = 'success';
    if v_memory_id is null then raise exception 'capture operation already in progress or failed'; end if;
    return v_memory_id;
  end if;

  v_memory_id := extensions.gen_random_uuid();
  v_content_hash := encode(extensions.digest(convert_to(p_canonical_content, 'UTF8'), 'sha256'), 'hex');
  v_evidence_hash := encode(extensions.digest(convert_to(p_evidence_text, 'UTF8'), 'sha256'), 'hex');
  insert into public.memory_items (
    id, user_id, canonical_content, content_hash, origin_system, memory_class,
    category, provenance_status, lifecycle_status, retrieval_tier, authority_tier,
    authority_policy_version, claim_key, importance, confidence, event_time,
    valid_from, valid_until, capture_policy_version
  ) values (
    v_memory_id, p_user_id, p_canonical_content, v_content_hash, 'xiaoc_native', p_memory_class,
    p_category, 'verified_user', 'active', null, 'native_verified',
    p_authority_policy_version, p_claim_key, p_importance, p_confidence, p_event_time,
    p_valid_from, p_valid_until, p_capture_policy_version
  );
  insert into public.memory_provenance (
    user_id, memory_id, source_kind, source_locator_key, source_message_id,
    source_conversation_id, source_role, evidence_text, evidence_hash,
    evidence_type, observed_at
  ) values (
    p_user_id, v_memory_id, 'message', 'message:' || p_source_message_id::text,
    p_source_message_id, p_source_conversation_id, 'user', p_evidence_text,
    v_evidence_hash, p_evidence_type, v_message.created_at
  );
  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, array[v_memory_id]
  );
  return v_memory_id;
end;
$$;

create or replace function public.xiaoc_memory_confirm_manual(
  p_user_id text,
  p_evidence_text text,
  p_canonical_content text,
  p_memory_class text,
  p_category text,
  p_claim_key text,
  p_capture_policy_version text,
  p_authority_policy_version text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_operation_id uuid;
  v_memory_id uuid;
begin
  insert into public.memory_operations (
    user_id, operation_type, idempotency_key, actor_type, policy_version
  ) values (p_user_id, 'manual_confirm', p_idempotency_key, 'user', p_capture_policy_version)
  on conflict (user_id, operation_type, idempotency_key) do nothing
  returning id into v_operation_id;
  if v_operation_id is null then
    select (affected_memory_ids)[1] into v_memory_id from public.memory_operations
    where user_id = p_user_id and operation_type = 'manual_confirm'
      and idempotency_key = p_idempotency_key and result_status = 'success';
    if v_memory_id is null then raise exception 'manual confirmation already in progress or failed'; end if;
    return v_memory_id;
  end if;
  v_memory_id := extensions.gen_random_uuid();
  insert into public.memory_items (
    id, user_id, canonical_content, content_hash, origin_system, memory_class,
    category, provenance_status, lifecycle_status, authority_tier,
    authority_policy_version, claim_key, capture_policy_version
  ) values (
    v_memory_id, p_user_id, p_canonical_content,
    encode(extensions.digest(convert_to(p_canonical_content, 'UTF8'), 'sha256'), 'hex'),
    'xiaoc_native', p_memory_class, p_category, 'manual_confirmed', 'active',
    'native_verified', p_authority_policy_version, p_claim_key, p_capture_policy_version
  );
  insert into public.memory_provenance (
    user_id, memory_id, source_kind, source_locator_key, source_operation_id,
    source_role, evidence_text, evidence_hash, evidence_type, observed_at
  ) values (
    p_user_id, v_memory_id, 'manual_user', 'manual:' || v_operation_id::text,
    v_operation_id, 'user', p_evidence_text,
    encode(extensions.digest(convert_to(p_evidence_text, 'UTF8'), 'sha256'), 'hex'),
    'confirmation', now()
  );
  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, array[v_memory_id]
  );
  return v_memory_id;
end;
$$;

create or replace function public.xiaoc_memory_apply_relation(
  p_user_id text,
  p_from_memory_id uuid,
  p_to_memory_id uuid,
  p_relation_type text,
  p_expected_from_revision bigint,
  p_expected_to_revision bigint,
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
  v_from public.memory_items%rowtype;
  v_to public.memory_items%rowtype;
  v_left uuid := p_from_memory_id;
  v_right uuid := p_to_memory_id;
begin
  if p_from_memory_id = p_to_memory_id then raise exception 'self relation is not allowed'; end if;
  if p_relation_type not in ('supersedes', 'contradicts', 'duplicates', 'revalidates') then
    raise exception 'relation type requires a different protected workflow';
  end if;
  perform 1 from public.memory_items
  where user_id = p_user_id and id in (p_from_memory_id, p_to_memory_id)
  order by id for update;
  select * into v_from from public.memory_items where user_id = p_user_id and id = p_from_memory_id;
  select * into v_to from public.memory_items where user_id = p_user_id and id = p_to_memory_id;
  if v_from.id is null or v_to.id is null then raise exception 'same-user relation endpoints required'; end if;
  if v_from.revision <> p_expected_from_revision or v_to.revision <> p_expected_to_revision then
    raise exception 'stale memory revision';
  end if;
  if p_relation_type = 'supersedes' and exists (
    with recursive chain(id) as (
      select r.to_memory_id from public.memory_relations r
      where r.user_id = p_user_id and r.from_memory_id = p_to_memory_id
        and r.relation_type = 'supersedes'
      union
      select r.to_memory_id from public.memory_relations r join chain c on r.from_memory_id = c.id
      where r.user_id = p_user_id and r.relation_type = 'supersedes'
    ) select 1 from chain where id = p_from_memory_id
  ) then raise exception 'supersedes cycle rejected'; end if;
  if p_relation_type = 'revalidates' and not (
    v_from.origin_system = 'xiaoc_native'
    and v_from.provenance_status in ('verified_user', 'derived_verified', 'manual_confirmed')
    and v_to.provenance_status = 'legacy_unverified'
  ) then raise exception 'invalid revalidates endpoints'; end if;
  if p_relation_type = 'duplicates' and v_left > v_right then
    v_left := p_to_memory_id; v_right := p_from_memory_id;
  end if;
  insert into public.memory_operations (
    user_id, operation_type, idempotency_key, actor_type, policy_version
  ) values (p_user_id, 'relation_' || p_relation_type, p_idempotency_key, 'system', p_policy_version)
  on conflict (user_id, operation_type, idempotency_key) do nothing
  returning id into v_operation_id;
  if v_operation_id is null then
    select id into v_operation_id from public.memory_operations
    where user_id = p_user_id and operation_type = 'relation_' || p_relation_type
      and idempotency_key = p_idempotency_key and result_status = 'success';
    if v_operation_id is null then raise exception 'relation operation already in progress or failed'; end if;
    return v_operation_id;
  end if;
  insert into public.memory_relations (
    user_id, from_memory_id, to_memory_id, relation_type, operation_id
  ) values (p_user_id, v_left, v_right, p_relation_type, v_operation_id)
  on conflict (user_id, from_memory_id, to_memory_id, relation_type) do nothing;
  if p_relation_type = 'supersedes' then
    update public.memory_items set
      lifecycle_status = 'superseded', superseded_at = now(),
      retrieval_tier = case when provenance_status = 'legacy_unverified' then 'quarantined' else retrieval_tier end,
      authority_tier = case when provenance_status = 'legacy_unverified' then 'none' else authority_tier end,
      revision = revision + 1, updated_at = now()
    where user_id = p_user_id and id = p_to_memory_id;
  elsif p_relation_type = 'revalidates' then
    update public.memory_items set retrieval_tier = 'disabled', authority_tier = 'none',
      revision = revision + 1, updated_at = now()
    where user_id = p_user_id and id = p_to_memory_id;
  end if;
  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, array[p_from_memory_id, p_to_memory_id]
  );
  return v_operation_id;
end;
$$;

create or replace function public.xiaoc_memory_consolidate(
  p_user_id text,
  p_source_memory_ids uuid[],
  p_canonical_content text,
  p_category text,
  p_claim_key text,
  p_confidence numeric,
  p_expected_source_revisions bigint[],
  p_policy_version text,
  p_authority_policy_version text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_operation_id uuid;
  v_memory_id uuid;
  v_source_id uuid;
  v_index integer;
begin
  if coalesce(array_length(p_source_memory_ids, 1), 0) < 3
     or array_length(p_source_memory_ids, 1) <> array_length(p_expected_source_revisions, 1) then
    raise exception 'at least three source memories with revisions are required';
  end if;
  perform 1 from public.memory_items
  where user_id = p_user_id and id = any(p_source_memory_ids)
  order by id for update;
  if (select count(distinct id) from public.memory_items
      where user_id = p_user_id and id = any(p_source_memory_ids)
        and origin_system = 'xiaoc_native'
        and memory_class = 'observation'
        and provenance_status in ('verified_user', 'manual_confirmed'))
     <> array_length(p_source_memory_ids, 1) then
    raise exception 'consolidation sources must be unique verified native observations';
  end if;
  for v_index in 1..array_length(p_source_memory_ids, 1) loop
    if not exists (select 1 from public.memory_items where user_id = p_user_id
      and id = p_source_memory_ids[v_index] and revision = p_expected_source_revisions[v_index]) then
      raise exception 'stale consolidation source revision';
    end if;
  end loop;
  insert into public.memory_operations (user_id, operation_type, idempotency_key, actor_type, policy_version)
  values (p_user_id, 'consolidate', p_idempotency_key, 'system', p_policy_version)
  on conflict (user_id, operation_type, idempotency_key) do nothing returning id into v_operation_id;
  if v_operation_id is null then
    select (affected_memory_ids)[1] into v_memory_id from public.memory_operations
    where user_id = p_user_id and operation_type = 'consolidate'
      and idempotency_key = p_idempotency_key and result_status = 'success';
    if v_memory_id is null then raise exception 'consolidation already in progress or failed'; end if;
    return v_memory_id;
  end if;
  v_memory_id := extensions.gen_random_uuid();
  insert into public.memory_items (
    id, user_id, canonical_content, content_hash, origin_system, memory_class,
    category, provenance_status, lifecycle_status, authority_tier,
    authority_policy_version, claim_key, confidence, capture_policy_version
  ) values (
    v_memory_id, p_user_id, p_canonical_content,
    encode(extensions.digest(convert_to(p_canonical_content, 'UTF8'), 'sha256'), 'hex'),
    'xiaoc_native', 'stable', p_category, 'derived_verified', 'active',
    'native_verified', p_authority_policy_version, p_claim_key, p_confidence, p_policy_version
  );
  foreach v_source_id in array p_source_memory_ids loop
    insert into public.memory_relations (
      user_id, from_memory_id, to_memory_id, relation_type, operation_id
    ) values (p_user_id, v_memory_id, v_source_id, 'consolidates', v_operation_id);
  end loop;
  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, array_append(p_source_memory_ids, v_memory_id)
  );
  return v_memory_id;
end;
$$;

create or replace function public.xiaoc_memory_import_legacy(
  p_user_id text,
  p_import_run_id uuid,
  p_source_system text,
  p_legacy_external_id text,
  p_original_relative_path text,
  p_original_content text,
  p_original_content_hash text,
  p_original_metadata jsonb,
  p_original_lifecycle_hints jsonb,
  p_legacy_pin_candidate boolean,
  p_original_archive_state text,
  p_original_created_at timestamptz,
  p_original_last_active_at timestamptz,
  p_original_activation_count integer,
  p_legacy_policy_version text,
  p_initial_retrieval_tier text,
  p_legacy_duplicate_cluster_id text,
  p_category text,
  p_memory_class text,
  p_authority_policy_version text,
  p_capture_policy_version text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_namespace constant uuid := 'f1c7e436-ff13-5d2c-8e4a-5de7386b6db7'::uuid;
  v_memory_id uuid;
  v_operation_id uuid;
  v_existing_hash text;
  v_authority text;
  v_inserted integer;
begin
  if not exists (select 1 from public.memory_import_runs where user_id = p_user_id
    and id = p_import_run_id and source_system = p_source_system
    and run_status in ('planned', 'applying')) then
    raise exception 'valid same-user import run required';
  end if;
  if p_original_content_hash <> encode(extensions.digest(convert_to(p_original_content, 'UTF8'), 'sha256'), 'hex') then
    raise exception 'legacy original content hash mismatch';
  end if;
  v_memory_id := extensions.uuid_generate_v5(
    v_namespace,
    p_user_id || chr(31) || p_source_system || chr(31) || p_legacy_external_id
  );
  select content_hash into v_existing_hash from public.memory_items
  where user_id = p_user_id and id = v_memory_id for update;
  if found then
    if v_existing_hash <> p_original_content_hash then
      raise exception 'legacy identity content hash conflict';
    end if;
    if not exists (select 1 from public.legacy_memory_map where user_id = p_user_id
      and source_system = p_source_system and legacy_external_id = p_legacy_external_id
      and memory_id = v_memory_id and original_content_hash = p_original_content_hash) then
      raise exception 'legacy identity exists without matching immutable map';
    end if;
    return v_memory_id;
  end if;
  insert into public.memory_operations (
    user_id, operation_type, idempotency_key, actor_type, policy_version
  ) values (
    p_user_id, 'legacy_import',
    p_source_system || ':' || p_legacy_external_id || ':' || p_original_content_hash,
    'migration', p_legacy_policy_version
  ) on conflict (user_id, operation_type, idempotency_key) do nothing
  returning id into v_operation_id;
  if v_operation_id is null then
    select m.memory_id into v_memory_id
    from public.legacy_memory_map m
    join public.memory_items i on i.user_id = m.user_id and i.id = m.memory_id
    where m.user_id = p_user_id and m.source_system = p_source_system
      and m.legacy_external_id = p_legacy_external_id
      and m.original_content_hash = p_original_content_hash
      and i.content_hash = p_original_content_hash;
    if v_memory_id is null then
      raise exception 'legacy import operation already in progress, failed, or conflicts';
    end if;
    return v_memory_id;
  end if;
  v_authority := case when p_initial_retrieval_tier in ('active_legacy', 'low_authority')
    then 'legacy_limited' else 'none' end;
  insert into public.memory_items (
    id, user_id, canonical_content, content_hash, origin_system, memory_class,
    category, provenance_status, lifecycle_status, retrieval_tier, authority_tier,
    authority_policy_version, capture_policy_version, created_at, updated_at
  ) values (
    v_memory_id, p_user_id, p_original_content, p_original_content_hash,
    'ombre_legacy', p_memory_class, p_category, 'legacy_unverified', 'active',
    p_initial_retrieval_tier, v_authority, p_authority_policy_version,
    p_capture_policy_version, coalesce(p_original_created_at, now()), now()
  ) on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select content_hash into v_existing_hash from public.memory_items
    where user_id = p_user_id and id = v_memory_id;
    if v_existing_hash is distinct from p_original_content_hash then
      raise exception 'legacy deterministic identity content hash conflict';
    end if;
  end if;
  insert into public.legacy_memory_map (
    user_id, import_run_id, memory_id, source_system, legacy_external_id,
    original_relative_path, original_content, original_content_hash,
    original_metadata, original_lifecycle_hints, legacy_pin_candidate,
    original_archive_state, original_created_at, original_last_active_at,
    original_activation_count, legacy_policy_version, initial_retrieval_tier,
    legacy_duplicate_cluster_id
  ) values (
    p_user_id, p_import_run_id, v_memory_id, p_source_system, p_legacy_external_id,
    p_original_relative_path, p_original_content, p_original_content_hash,
    coalesce(p_original_metadata, '{}'::jsonb), coalesce(p_original_lifecycle_hints, '{}'::jsonb),
    p_legacy_pin_candidate, p_original_archive_state, p_original_created_at,
    p_original_last_active_at, p_original_activation_count, p_legacy_policy_version,
    p_initial_retrieval_tier, p_legacy_duplicate_cluster_id
  ) on conflict (user_id, source_system, legacy_external_id) do nothing;
  if not exists (select 1 from public.legacy_memory_map where user_id = p_user_id
    and source_system = p_source_system and legacy_external_id = p_legacy_external_id
    and memory_id = v_memory_id and original_content_hash = p_original_content_hash) then
    raise exception 'legacy immutable map conflicts with deterministic identity';
  end if;
  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, array[v_memory_id]
  );
  return v_memory_id;
end;
$$;

create or replace function public.xiaoc_memory_activate_embedding(
  p_user_id text,
  p_embedding_id uuid,
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
  v_memory_id uuid;
begin
  select memory_id into v_memory_id from public.memory_embeddings
  where user_id = p_user_id and id = p_embedding_id for update;
  if not found then raise exception 'same-user embedding not found'; end if;
  perform 1 from public.memory_embeddings where user_id = p_user_id
    and memory_id = v_memory_id order by id for update;
  if not exists (select 1 from public.memory_embeddings where user_id = p_user_id
    and id = p_embedding_id and rollout_status = 'shadow') then
    raise exception 'only a shadow embedding can be activated';
  end if;
  insert into public.memory_operations (user_id, operation_type, idempotency_key, actor_type, policy_version)
  values (p_user_id, 'embedding_activate', p_idempotency_key, 'system', p_policy_version)
  on conflict (user_id, operation_type, idempotency_key) do nothing returning id into v_operation_id;
  if v_operation_id is null then
    select id into v_operation_id from public.memory_operations where user_id = p_user_id
      and operation_type = 'embedding_activate' and idempotency_key = p_idempotency_key
      and result_status = 'success';
    if v_operation_id is null then raise exception 'embedding activation in progress or failed'; end if;
    return v_operation_id;
  end if;
  update public.memory_embeddings set rollout_status = 'retired'
  where user_id = p_user_id and memory_id = v_memory_id and rollout_status = 'active';
  update public.memory_embeddings set rollout_status = 'active'
  where user_id = p_user_id and id = p_embedding_id and rollout_status = 'shadow';
  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, array[v_memory_id]
  );
  return v_operation_id;
end;
$$;

create or replace function public.xiaoc_memory_register_embedding(
  p_user_id text,
  p_memory_id uuid,
  p_provider text,
  p_model text,
  p_embedding_version text,
  p_preprocessor_version text,
  p_content_hash text,
  p_embedding extensions.vector,
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
  v_embedding_id uuid;
  v_memory_hash text;
begin
  select content_hash into v_memory_hash from public.memory_items
  where user_id = p_user_id and id = p_memory_id;
  if not found or v_memory_hash <> p_content_hash then
    raise exception 'same-user memory and matching content hash required';
  end if;
  insert into public.memory_operations (user_id, operation_type, idempotency_key, actor_type, policy_version)
  values (p_user_id, 'embedding_generate', p_idempotency_key, 'system', p_policy_version)
  on conflict (user_id, operation_type, idempotency_key) do nothing returning id into v_operation_id;
  if v_operation_id is null then
    select e.id into v_embedding_id
    from public.memory_embeddings e
    where e.user_id = p_user_id and e.memory_id = p_memory_id
      and e.provider = p_provider and e.model = p_model
      and e.embedding_version = p_embedding_version
      and e.preprocessor_version = p_preprocessor_version
      and e.content_hash = p_content_hash;
    if v_embedding_id is null then raise exception 'embedding operation already in progress or failed'; end if;
    return v_embedding_id;
  end if;
  insert into public.memory_embeddings (
    user_id, memory_id, provider, model, embedding_version,
    preprocessor_version, dimensions, content_hash, embedding, rollout_status
  ) values (
    p_user_id, p_memory_id, p_provider, p_model, p_embedding_version,
    p_preprocessor_version, extensions.vector_dims(p_embedding), p_content_hash,
    p_embedding, 'shadow'
  ) on conflict (
    user_id, memory_id, provider, model, embedding_version,
    preprocessor_version, content_hash
  ) do nothing returning id into v_embedding_id;
  if v_embedding_id is null then
    select id into v_embedding_id from public.memory_embeddings
    where user_id = p_user_id and memory_id = p_memory_id
      and provider = p_provider and model = p_model
      and embedding_version = p_embedding_version
      and preprocessor_version = p_preprocessor_version and content_hash = p_content_hash;
  end if;
  perform public.xiaoc_memory_finish_operation(
    p_user_id, v_operation_id, 'success', null, array[p_memory_id]
  );
  return v_embedding_id;
end;
$$;

create or replace function public.xiaoc_memory_create_import_run(
  p_user_id text,
  p_source_system text,
  p_source_archive_sha256 text,
  p_importer_version text,
  p_legacy_policy_version text,
  p_source_file_count integer,
  p_planned_count integer
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_run_id uuid;
begin
  insert into public.memory_import_runs (
    user_id, source_system, source_archive_sha256, importer_version,
    legacy_policy_version, source_file_count, planned_count
  ) values (
    p_user_id, p_source_system, p_source_archive_sha256, p_importer_version,
    p_legacy_policy_version, p_source_file_count, p_planned_count
  ) on conflict (
    user_id, source_system, source_archive_sha256, importer_version, legacy_policy_version
  ) do nothing returning id into v_run_id;
  if v_run_id is null then
    select id into v_run_id from public.memory_import_runs
    where user_id = p_user_id and source_system = p_source_system
      and source_archive_sha256 = p_source_archive_sha256
      and importer_version = p_importer_version
      and legacy_policy_version = p_legacy_policy_version;
  end if;
  return v_run_id;
end;
$$;

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
  select * into v_memory from public.memory_items where user_id = p_user_id and id = p_memory_id for update;
  if not found then raise exception 'same-user memory not found'; end if;
  if p_active and not (
    v_memory.origin_system = 'xiaoc_native'
    and v_memory.provenance_status in ('verified_user', 'derived_verified', 'manual_confirmed')
    and v_memory.lifecycle_status = 'active'
    and v_memory.retrieval_tier is null
  ) then raise exception 'memory is not eligible for native PIN'; end if;
  insert into public.memory_operations (user_id, operation_type, idempotency_key, actor_type, policy_version)
  values (p_user_id, case when p_active then 'pin' else 'unpin' end,
    p_idempotency_key, 'user', p_policy_version)
  on conflict (user_id, operation_type, idempotency_key) do nothing returning id into v_operation_id;
  if v_operation_id is null then
    select id into v_operation_id from public.memory_operations where user_id = p_user_id
      and operation_type = case when p_active then 'pin' else 'unpin' end
      and idempotency_key = p_idempotency_key and result_status = 'success';
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
  ) on conflict (user_id, memory_id, scope) do update set
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

-- RLS is one isolation layer; composite FKs and protected RPCs remain mandatory.
alter table public.memory_items enable row level security;
alter table public.memory_provenance enable row level security;
alter table public.memory_relations enable row level security;
alter table public.memory_embeddings enable row level security;
alter table public.memory_pins enable row level security;
alter table public.memory_operations enable row level security;
alter table public.memory_import_runs enable row level security;
alter table public.legacy_memory_map enable row level security;

revoke all on public.memory_items from public, anon, authenticated;
revoke all on public.memory_provenance from public, anon, authenticated;
revoke all on public.memory_relations from public, anon, authenticated;
revoke all on public.memory_embeddings from public, anon, authenticated;
revoke all on public.memory_pins from public, anon, authenticated;
revoke all on public.memory_operations from public, anon, authenticated;
revoke all on public.memory_import_runs from public, anon, authenticated;
revoke all on public.legacy_memory_map from public, anon, authenticated;

revoke insert, update, delete on public.memory_items from service_role;
revoke insert, update, delete on public.memory_provenance from service_role;
revoke insert, update, delete on public.memory_relations from service_role;
revoke insert, update, delete on public.memory_embeddings from service_role;
revoke insert, update, delete on public.memory_pins from service_role;
revoke insert, update, delete on public.memory_operations from service_role;
revoke insert, update, delete on public.memory_import_runs from service_role;
revoke insert, update, delete on public.legacy_memory_map from service_role;

grant select on public.memory_items to service_role;
grant select on public.memory_provenance to service_role;
grant select on public.memory_relations to service_role;
grant select on public.memory_embeddings to service_role;
grant select on public.memory_pins to service_role;
grant select on public.memory_operations to service_role;
grant select on public.memory_import_runs to service_role;
grant select on public.legacy_memory_map to service_role;

revoke all on function public.xiaoc_memory_capture_verified(
  text, uuid, text, text, text, text, text, text, text,
  timestamptz, timestamptz, timestamptz, smallint, numeric,
  text, text, text
) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_confirm_manual(
  text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_apply_relation(
  text, uuid, uuid, text, bigint, bigint, text, text
) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_consolidate(
  text, uuid[], text, text, text, numeric, bigint[], text, text, text
) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_import_legacy(
  text, uuid, text, text, text, text, text, jsonb, jsonb, boolean,
  text, timestamptz, timestamptz, integer, text, text, text, text,
  text, text, text
) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_activate_embedding(
  text, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_register_embedding(
  text, uuid, text, text, text, text, text, extensions.vector, text, text
) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_create_import_run(
  text, text, text, text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_set_pin(
  text, uuid, boolean, integer, text, text
) from public, anon, authenticated;
revoke all on function public.xiaoc_memory_finish_operation(
  text, uuid, text, text, uuid[], jsonb, jsonb
) from public, anon, authenticated;

grant execute on function public.xiaoc_memory_capture_verified(
  text, uuid, text, text, text, text, text, text, text,
  timestamptz, timestamptz, timestamptz, smallint, numeric,
  text, text, text
) to service_role;
grant execute on function public.xiaoc_memory_confirm_manual(
  text, text, text, text, text, text, text, text, text
) to service_role;
grant execute on function public.xiaoc_memory_apply_relation(
  text, uuid, uuid, text, bigint, bigint, text, text
) to service_role;
grant execute on function public.xiaoc_memory_consolidate(
  text, uuid[], text, text, text, numeric, bigint[], text, text, text
) to service_role;
grant execute on function public.xiaoc_memory_import_legacy(
  text, uuid, text, text, text, text, text, jsonb, jsonb, boolean,
  text, timestamptz, timestamptz, integer, text, text, text, text,
  text, text, text
) to service_role;
grant execute on function public.xiaoc_memory_activate_embedding(
  text, uuid, text, text
) to service_role;
grant execute on function public.xiaoc_memory_register_embedding(
  text, uuid, text, text, text, text, text, extensions.vector, text, text
) to service_role;
grant execute on function public.xiaoc_memory_create_import_run(
  text, text, text, text, text, integer, integer
) to service_role;
grant execute on function public.xiaoc_memory_set_pin(
  text, uuid, boolean, integer, text, text
) to service_role;

-- Internal helper functions are not callable through PostgREST roles.
grant execute on function public.xiaoc_memory_finish_operation(
  text, uuid, text, text, uuid[], jsonb, jsonb
) to service_role;
revoke all on function public.xiaoc_memory_assert_verified_integrity(text, uuid)
  from public, anon, authenticated, service_role;

comment on table public.memory_items is
  'XiaoC Memory Engine canonical claim versions; isolated from the current production memories table.';
comment on table public.legacy_memory_map is
  'Immutable legacy Ombre locators and source payload; never verified provenance.';

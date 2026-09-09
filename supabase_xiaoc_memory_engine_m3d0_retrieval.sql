-- XiaoC Memory Engine M3D0: bounded, read-only retrieval foundation.
-- Forward-only schema addition. This file does not enable runtime retrieval.

create or replace function public.xiaoc_memory_retrieval_row_eligible(
  p_item public.memory_items,
  p_retrieval_mode text,
  p_retrieval_at timestamptz
) returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
  select
    p_retrieval_mode in ('normal_current', 'historical_recall')
    and p_retrieval_at is not null
    and (
      (p_retrieval_mode = 'normal_current' and p_item.lifecycle_status = 'active')
      or (p_retrieval_mode = 'historical_recall' and p_item.lifecycle_status in ('active', 'archived'))
    )
    and (
      (
        p_item.provenance_status = 'legacy_unverified'
        and p_item.retrieval_tier in ('active_legacy', 'low_authority')
        and p_item.authority_tier = 'legacy_limited'
      )
      or (
        p_item.provenance_status in ('verified_user', 'manual_confirmed', 'derived_verified')
        and p_item.retrieval_tier is null
        and p_item.authority_tier = 'native_verified'
      )
    )
    and (
      p_retrieval_mode = 'historical_recall'
      or (
        p_item.resolved_at is null
        and (p_item.valid_from is null or p_item.valid_from <= p_retrieval_at)
        and (p_item.valid_until is null or p_item.valid_until >= p_retrieval_at)
      )
    );
$$;

create or replace function public.xiaoc_memory_retrieve_lexical_candidates(
  p_user_id text,
  p_retrieval_mode text,
  p_retrieval_at timestamptz,
  p_lexical_terms text[],
  p_limit integer
) returns table (
  memory_id uuid,
  user_id text,
  canonical_content text,
  content_hash text,
  origin_system text,
  memory_class text,
  category text,
  provenance_status text,
  lifecycle_status text,
  retrieval_tier text,
  authority_tier text,
  claim_key text,
  importance smallint,
  confidence numeric,
  event_time timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  resolved_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
begin
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'RETRIEVAL_USER_REQUIRED'; end if;
  if p_retrieval_mode not in ('normal_current', 'historical_recall') then raise exception 'RETRIEVAL_MODE_INVALID'; end if;
  if p_retrieval_at is null then raise exception 'RETRIEVAL_TIME_REQUIRED'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 32 then raise exception 'LEXICAL_LIMIT_INVALID'; end if;
  if p_lexical_terms is null or cardinality(p_lexical_terms) < 1 or cardinality(p_lexical_terms) > 12 then
    raise exception 'LEXICAL_TERMS_INVALID';
  end if;
  if exists (select 1 from unnest(p_lexical_terms) term where term is null or btrim(term) = '' or char_length(term) > 128) then
    raise exception 'LEXICAL_TERM_INVALID';
  end if;

  return query
  select
    mi.id, mi.user_id, mi.canonical_content, mi.content_hash, mi.origin_system,
    mi.memory_class, mi.category, mi.provenance_status, mi.lifecycle_status,
    mi.retrieval_tier, mi.authority_tier, mi.claim_key, mi.importance,
    mi.confidence, mi.event_time, mi.valid_from, mi.valid_until,
    mi.resolved_at, mi.created_at
  from public.memory_items mi
  where mi.user_id = p_user_id
    and public.xiaoc_memory_retrieval_row_eligible(mi, p_retrieval_mode, p_retrieval_at)
    and exists (
      select 1 from unnest(p_lexical_terms) term
      where position(lower(btrim(term)) in lower(mi.canonical_content)) > 0
    )
  order by mi.event_time desc nulls last, mi.created_at desc, mi.id
  limit p_limit;
end;
$$;

create or replace function public.xiaoc_memory_retrieve_semantic_candidates(
  p_user_id text,
  p_retrieval_mode text,
  p_retrieval_at timestamptz,
  p_query_embedding extensions.vector,
  p_provider text,
  p_model text,
  p_embedding_version text,
  p_preprocessor_version text,
  p_dimensions integer,
  p_limit integer
) returns table (
  memory_id uuid,
  user_id text,
  canonical_content text,
  content_hash text,
  origin_system text,
  memory_class text,
  category text,
  provenance_status text,
  lifecycle_status text,
  retrieval_tier text,
  authority_tier text,
  claim_key text,
  importance smallint,
  confidence numeric,
  event_time timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  resolved_at timestamptz,
  created_at timestamptz,
  embedding_id uuid,
  provider text,
  model text,
  embedding_version text,
  preprocessor_version text,
  dimensions integer,
  rollout_status text,
  semantic_similarity double precision
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
begin
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'RETRIEVAL_USER_REQUIRED'; end if;
  if p_retrieval_mode not in ('normal_current', 'historical_recall') then raise exception 'RETRIEVAL_MODE_INVALID'; end if;
  if p_retrieval_at is null then raise exception 'RETRIEVAL_TIME_REQUIRED'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 32 then raise exception 'SEMANTIC_LIMIT_INVALID'; end if;
  if p_query_embedding is null or p_dimensions is null or p_dimensions < 1
    or extensions.vector_dims(p_query_embedding) <> p_dimensions then raise exception 'SEMANTIC_VECTOR_DIMENSION_INVALID'; end if;
  if p_provider is null or btrim(p_provider) = '' or p_model is null or btrim(p_model) = ''
    or p_embedding_version is null or btrim(p_embedding_version) = ''
    or p_preprocessor_version is null or btrim(p_preprocessor_version) = '' then
    raise exception 'SEMANTIC_IDENTITY_INVALID';
  end if;

  return query
  select
    mi.id, mi.user_id, mi.canonical_content, mi.content_hash, mi.origin_system,
    mi.memory_class, mi.category, mi.provenance_status, mi.lifecycle_status,
    mi.retrieval_tier, mi.authority_tier, mi.claim_key, mi.importance,
    mi.confidence, mi.event_time, mi.valid_from, mi.valid_until,
    mi.resolved_at, mi.created_at,
    e.id, e.provider, e.model, e.embedding_version, e.preprocessor_version,
    e.dimensions, e.rollout_status,
    greatest(0::double precision, least(1::double precision, 1 - (e.embedding <=> p_query_embedding)))
  from public.memory_items mi
  join public.memory_embeddings e
    on e.user_id = mi.user_id and e.memory_id = mi.id
  where mi.user_id = p_user_id
    and public.xiaoc_memory_retrieval_row_eligible(mi, p_retrieval_mode, p_retrieval_at)
    and e.rollout_status = 'active'
    and e.content_hash = mi.content_hash
    and e.provider = p_provider
    and e.model = p_model
    and e.embedding_version = p_embedding_version
    and e.preprocessor_version = p_preprocessor_version
    and e.dimensions = p_dimensions
    and extensions.vector_dims(e.embedding) = p_dimensions
  order by e.embedding <=> p_query_embedding, mi.id
  limit p_limit;
end;
$$;

create or replace function public.xiaoc_memory_retrieve_candidate_relations(
  p_user_id text,
  p_candidate_memory_ids uuid[],
  p_limit integer
) returns table (
  relation_id uuid,
  user_id text,
  from_memory_id uuid,
  to_memory_id uuid,
  relation_type text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
begin
  if p_user_id is null or btrim(p_user_id) = '' then raise exception 'RETRIEVAL_USER_REQUIRED'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 128 then raise exception 'RELATION_LIMIT_INVALID'; end if;
  if p_candidate_memory_ids is null or cardinality(p_candidate_memory_ids) < 1 or cardinality(p_candidate_memory_ids) > 32
    or array_position(p_candidate_memory_ids, null) is not null then raise exception 'CANDIDATE_IDS_INVALID'; end if;

  return query
  select r.id, r.user_id, r.from_memory_id, r.to_memory_id, r.relation_type, r.created_at
  from public.memory_relations r
  where r.user_id = p_user_id
    and (r.from_memory_id = any(p_candidate_memory_ids) or r.to_memory_id = any(p_candidate_memory_ids))
  order by r.created_at, r.id
  limit p_limit;
end;
$$;

revoke all on function public.xiaoc_memory_retrieval_row_eligible(public.memory_items,text,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.xiaoc_memory_retrieve_lexical_candidates(text,text,timestamptz,text[],integer)
  from public, anon, authenticated;
revoke all on function public.xiaoc_memory_retrieve_semantic_candidates(text,text,timestamptz,extensions.vector,text,text,text,text,integer,integer)
  from public, anon, authenticated;
revoke all on function public.xiaoc_memory_retrieve_candidate_relations(text,uuid[],integer)
  from public, anon, authenticated;

grant execute on function public.xiaoc_memory_retrieve_lexical_candidates(text,text,timestamptz,text[],integer)
  to service_role;
grant execute on function public.xiaoc_memory_retrieve_semantic_candidates(text,text,timestamptz,extensions.vector,text,text,text,text,integer,integer)
  to service_role;
grant execute on function public.xiaoc_memory_retrieve_candidate_relations(text,uuid[],integer)
  to service_role;

-- No table grants and no mutation functions are added by M3D0.

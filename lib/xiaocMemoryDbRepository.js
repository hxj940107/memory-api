import { validateEmbeddingIdentity, validateEmbeddingVector } from "./xiaocMemoryEmbedding.js"

const PROVENANCE = new Set(["verified_user", "manual_confirmed", "derived_verified", "legacy_unverified"])
const LIFECYCLE = new Set(["active", "superseded", "archived", "deleted"])
const TIERS = new Set([null, "active_legacy", "low_authority", "shadow_only", "quarantined", "disabled"])
const AUTHORITY = new Set(["native_verified", "legacy_limited", "none"])
const RELATIONS = new Set(["supersedes", "consolidates", "contradicts", "duplicates", "revalidates"])

function requireText(value, code) {
  const text = String(value || "").trim()
  if (!text) throw new Error(code)
  return text
}

function validateLimit(value, maximum, code) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(code)
  return value
}

function mapMemoryRow(row, expectedUserId) {
  if (!row || String(row.user_id || "") !== String(expectedUserId) || !row.memory_id) throw new Error("DB_CANDIDATE_USER_OR_ID_INVALID")
  if (!String(row.canonical_content || "").trim() || !/^[0-9a-f]{64}$/.test(String(row.content_hash || ""))) throw new Error("DB_CANDIDATE_CONTENT_INVALID")
  if (!PROVENANCE.has(row.provenance_status) || !LIFECYCLE.has(row.lifecycle_status)
    || !TIERS.has(row.retrieval_tier ?? null) || !AUTHORITY.has(row.authority_tier)) throw new Error("DB_CANDIDATE_POLICY_FIELDS_INVALID")
  return {
    id: row.memory_id, user_id: row.user_id, canonical_content: row.canonical_content,
    content_hash: row.content_hash, origin_system: row.origin_system, memory_class: row.memory_class,
    category: row.category, provenance_status: row.provenance_status, lifecycle_status: row.lifecycle_status,
    retrieval_tier: row.retrieval_tier ?? null, authority_tier: row.authority_tier,
    claim_key: row.claim_key ?? null, importance: row.importance ?? null, confidence: row.confidence ?? null,
    event_time: row.event_time ?? null, valid_from: row.valid_from ?? null, valid_until: row.valid_until ?? null,
    resolved_at: row.resolved_at ?? null, created_at: row.created_at ?? null,
  }
}

export class XiaoCMemoryDbRetrievalRepository {
  constructor(client, { retrievalMode = "normal_current", retrievalTime, embeddingIdentity = null } = {}) {
    if (!client?.rpc) throw new Error("SUPABASE_RPC_CLIENT_REQUIRED")
    if (!["normal_current", "historical_recall"].includes(retrievalMode)) throw new Error("RETRIEVAL_MODE_INVALID")
    if (!Number.isFinite(Date.parse(retrievalTime))) throw new Error("RETRIEVAL_TIME_INVALID")
    this.client = client
    this.retrievalMode = retrievalMode
    this.retrievalTime = retrievalTime
    this.embeddingIdentity = embeddingIdentity ? validateEmbeddingIdentity(embeddingIdentity) : null
  }

  async listLexicalCandidates({ userId, lexicalTerms, limit }) {
    const owner = requireText(userId, "USER_ID_REQUIRED")
    validateLimit(limit, 32, "LEXICAL_LIMIT_INVALID")
    const terms = [...new Set((lexicalTerms || []).map((term) => String(term || "").trim()).filter(Boolean))]
    if (!terms.length || terms.length > 12 || terms.some((term) => [...term].length > 128)) throw new Error("LEXICAL_TERMS_INVALID")
    const { data, error } = await this.client.rpc("xiaoc_memory_retrieve_lexical_candidates", {
      p_user_id: owner, p_retrieval_mode: this.retrievalMode, p_retrieval_at: this.retrievalTime,
      p_lexical_terms: terms, p_limit: limit,
    })
    if (error) throw new Error(`LEXICAL_RPC_FAILED:${error.code || "UNKNOWN"}`)
    if (!Array.isArray(data) || data.length > limit) throw new Error("LEXICAL_RPC_RESPONSE_INVALID")
    return data.map((row) => mapMemoryRow(row, owner))
  }

  async listSemanticCandidates({ userId, queryEmbedding, embeddingIdentity, limit }) {
    const owner = requireText(userId, "USER_ID_REQUIRED")
    validateLimit(limit, 32, "SEMANTIC_LIMIT_INVALID")
    const identity = validateEmbeddingIdentity(embeddingIdentity || this.embeddingIdentity)
    validateEmbeddingVector(queryEmbedding, identity.dimension)
    const { data, error } = await this.client.rpc("xiaoc_memory_retrieve_semantic_candidates", {
      p_user_id: owner, p_retrieval_mode: this.retrievalMode, p_retrieval_at: this.retrievalTime,
      p_query_embedding: queryEmbedding, p_provider: identity.providerId, p_model: identity.modelId,
      p_embedding_version: identity.version, p_preprocessor_version: identity.preprocessorVersion,
      p_dimensions: identity.dimension, p_limit: limit,
    })
    if (error) throw new Error(`SEMANTIC_RPC_FAILED:${error.code || "UNKNOWN"}`)
    if (!Array.isArray(data) || data.length > limit) throw new Error("SEMANTIC_RPC_RESPONSE_INVALID")
    return data.map((row) => {
      const memory = mapMemoryRow(row, owner)
      if (row.rollout_status !== "active" || row.provider !== identity.providerId || row.model !== identity.modelId
        || row.embedding_version !== identity.version || row.preprocessor_version !== identity.preprocessorVersion
        || Number(row.dimensions) !== identity.dimension || !Number.isFinite(Number(row.semantic_similarity))
        || Number(row.semantic_similarity) < 0 || Number(row.semantic_similarity) > 1) throw new Error("SEMANTIC_RPC_IDENTITY_OR_SCORE_INVALID")
      return { memory, semantic_similarity: Number(row.semantic_similarity), rollout_status: row.rollout_status,
        provider: row.provider, model: row.model, embedding_version: row.embedding_version,
        preprocessor_version: row.preprocessor_version, dimensions: Number(row.dimensions) }
    })
  }

  async listRelations({ userId, memoryIds }) {
    const owner = requireText(userId, "USER_ID_REQUIRED")
    const ids = [...new Set((memoryIds || []).map(String).filter(Boolean))]
    if (!ids.length || ids.length > 32) throw new Error("CANDIDATE_IDS_INVALID")
    const { data, error } = await this.client.rpc("xiaoc_memory_retrieve_candidate_relations", {
      p_user_id: owner, p_candidate_memory_ids: ids, p_limit: 128,
    })
    if (error) throw new Error(`RELATION_RPC_FAILED:${error.code || "UNKNOWN"}`)
    if (!Array.isArray(data) || data.length > 128) throw new Error("RELATION_RPC_RESPONSE_INVALID")
    return data.map((row) => {
      if (!row?.relation_id || String(row.user_id || "") !== owner || !row.from_memory_id || !row.to_memory_id
        || !RELATIONS.has(row.relation_type)) throw new Error("RELATION_RPC_ROW_INVALID")
      return { id: row.relation_id, user_id: row.user_id, from_memory_id: row.from_memory_id,
        to_memory_id: row.to_memory_id, relation_type: row.relation_type, created_at: row.created_at ?? null }
    })
  }
}

export function buildXiaoCMemoryShadowTelemetry(result) {
  const trace = result?.trace || {}
  return {
    attempted: trace.query_plan?.should_retrieve === true,
    lexical_candidate_count: trace.channel_candidate_counts?.lexical || 0,
    semantic_candidate_count: trace.channel_candidate_counts?.semantic || 0,
    eligible_count: trace.eligible_count || 0,
    suppressed_count: trace.suppressed_count || 0,
    selected_count: trace.selected_count || 0,
    degradation_mode: trace.degradation_mode || "UNKNOWN",
    reason_code_counts: trace.reason_code_counts || {},
    latency_ms: trace.latency_ms?.total ?? null,
  }
}

import { cosineSimilarity, validateEmbeddingVector } from "./xiaocMemoryEmbedding.js"
import { scoreLexicalMatch } from "./xiaocMemoryLexical.js"

const NATIVE_PROVENANCE = new Set(["verified_user", "manual_confirmed", "derived_verified"])
const EXCLUDED_TIERS = new Set(["shadow_only", "quarantined", "disabled"])

export function evaluateRetrievalEligibility(memory, { userId, mode = "normal" } = {}) {
  const reasons = []
  if (!userId || String(memory?.user_id || "") !== String(userId)) reasons.push("USER_SCOPE_MISMATCH")
  if (memory?.lifecycle_status !== "active") reasons.push(`LIFECYCLE_${String(memory?.lifecycle_status || "unknown").toUpperCase()}`)
  if (mode === "normal" && EXCLUDED_TIERS.has(memory?.retrieval_tier)) reasons.push(`TIER_${memory.retrieval_tier.toUpperCase()}`)

  const legacy = memory?.provenance_status === "legacy_unverified"
  if (legacy) {
    if (!["low_authority", "active_legacy"].includes(memory?.retrieval_tier)) reasons.push("LEGACY_TIER_NOT_ELIGIBLE")
    if (memory?.authority_tier !== "legacy_limited") reasons.push("LEGACY_AUTHORITY_INVALID")
  } else {
    if (!NATIVE_PROVENANCE.has(memory?.provenance_status)) reasons.push("NATIVE_PROVENANCE_INVALID")
    if (memory?.authority_tier !== "native_verified") reasons.push("NATIVE_AUTHORITY_INVALID")
  }

  return {
    eligible: reasons.length === 0,
    authorityBand: legacy ? "legacy_limited" : "native_verified",
    reasonCodes: reasons.length ? reasons : [legacy ? "ELIGIBLE_LEGACY_LIMITED" : "ELIGIBLE_NATIVE_VERIFIED"],
  }
}

export function buildHybridCandidate({ memory, userId, query, queryEmbedding = null, memoryEmbedding = null }) {
  const eligibility = evaluateRetrievalEligibility(memory, { userId })
  const lexical = scoreLexicalMatch(query, memory?.canonical_content)
  let semanticScore = null
  let semanticAvailable = false
  const semanticReasonCodes = []
  if (queryEmbedding !== null && memoryEmbedding !== null) {
    try {
      validateEmbeddingVector(queryEmbedding, queryEmbedding.length)
      validateEmbeddingVector(memoryEmbedding, queryEmbedding.length)
      semanticScore = Number(cosineSimilarity(queryEmbedding, memoryEmbedding).toFixed(6))
      semanticAvailable = true
      semanticReasonCodes.push("SEMANTIC_COSINE_AVAILABLE")
    } catch (error) {
      semanticReasonCodes.push(error.message)
    }
  } else {
    semanticReasonCodes.push("SEMANTIC_UNAVAILABLE")
  }

  return {
    memory_id: memory?.id || null,
    user_id: memory?.user_id || null,
    canonical_content: memory?.canonical_content || "",
    content_hash: memory?.content_hash || null,
    provenance_status: memory?.provenance_status || null,
    authority_tier: memory?.authority_tier || null,
    retrieval_tier: memory?.retrieval_tier ?? null,
    lifecycle_status: memory?.lifecycle_status || null,
    claim_key: memory?.claim_key ?? null,
    importance: memory?.importance ?? null,
    valid_from: memory?.valid_from ?? null,
    valid_until: memory?.valid_until ?? null,
    resolved_at: memory?.resolved_at ?? null,
    eligible: eligibility.eligible,
    eligibility_reason_codes: eligibility.reasonCodes,
    authority_band: eligibility.authorityBand,
    lexical_score: lexical.score,
    lexical_reason_codes: lexical.reasonCodes,
    lexical_components: lexical.components,
    semantic_score: semanticScore,
    semantic_available: semanticAvailable,
    semantic_reason_codes: semanticReasonCodes,
  }
}

export async function retrieveOfflineCandidates({
  repository,
  userId,
  query,
  queryEmbedding = null,
  limit = 20,
}) {
  if (!repository?.listCandidates) throw new Error("OFFLINE_REPOSITORY_REQUIRED")
  if (!userId) throw new Error("USER_ID_REQUIRED")
  if (!String(query || "").trim()) return []
  const rows = await repository.listCandidates({ userId })
  const candidates = []
  for (const memory of rows || []) {
    const embedding = queryEmbedding && repository.readEmbedding
      ? await repository.readEmbedding({ userId, memoryId: memory.id })
      : null
    const vector = embedding?.embedding || embedding?.vector || null
    const candidate = buildHybridCandidate({ memory, userId, query, queryEmbedding, memoryEmbedding: vector })
    if (candidate.eligible) candidates.push(candidate)
  }
  // This is candidate ordering, not the future M3 ranking contract.
  candidates.sort((left, right) => (
    Math.max(right.lexical_score, right.semantic_score ?? 0)
    - Math.max(left.lexical_score, left.semantic_score ?? 0)
    || String(left.memory_id).localeCompare(String(right.memory_id))
  ))
  return candidates.slice(0, Math.max(0, Number(limit) || 0))
}

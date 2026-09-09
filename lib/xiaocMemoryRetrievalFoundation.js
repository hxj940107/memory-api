import { cosineSimilarity, validateEmbeddingVector } from "./xiaocMemoryEmbedding.js"
import { scoreLexicalMatch } from "./xiaocMemoryLexical.js"
import { evaluateCandidateEligibility, resolveMemoryCandidates } from "./xiaocMemoryEligibility.js"

export function evaluateRetrievalEligibility(memory, { userId, mode = "normal" } = {}) {
  const decision = evaluateCandidateEligibility(memory, { userId, mode })
  return {
    eligible: decision.eligible,
    authorityBand: decision.authority,
    reasonCodes: decision.reason_codes,
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
    event_time: memory?.event_time ?? null,
    created_at: memory?.created_at ?? null,
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

export function resolveOfflineCandidateEligibility({ candidates, relations = [], userId, retrievalTime, mode = "normal_current", externalClaims = [] }) {
  return resolveMemoryCandidates({ candidates, relations, context: { userId, retrievalTime, mode, externalClaims } })
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

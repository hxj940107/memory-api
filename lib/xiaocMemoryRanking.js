import { buildHybridCandidate, resolveOfflineCandidateEligibility } from "./xiaocMemoryRetrievalFoundation.js"
import { validateEmbeddingIdentity } from "./xiaocMemoryEmbedding.js"
import { buildXiaoCMemoryQueryPlan } from "./xiaocMemoryQueryPlan.js"

export const XIAOC_MEMORY_RETRIEVAL_POLICY = Object.freeze({
  version: "m3b3-offline-v1",
  lexicalCandidateLimit: 24,
  semanticCandidateLimit: 24,
  combinedCandidateLimit: 32,
  defaultTopK: 3,
  maximumTopK: 5,
  legacySlotLimit: 1,
  thresholds: Object.freeze({ lexical_only: 0.28, semantic_only: 0.58, hybrid: 0.32 }),
  semanticAdmission: Object.freeze({ groundedMinimum: 0.82, conflictingLexicalFloor: 0.72 }),
  weights: Object.freeze({ relevance: 0.88, importance: 0.04, recency: 0.03, authority: 0.02, recall: 0.03 }),
})

const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0))
const round = (value) => Number(value.toFixed(6))

function itemId(row) {
  return String(row?.memory?.id ?? row?.id ?? row?.memory_id ?? "")
}

function memoryOf(row) {
  return row?.memory || row
}

function boundedRows(rows, limit, channel) {
  if (!Array.isArray(rows)) throw new Error(`${channel}_CANDIDATES_INVALID`)
  if (rows.length > limit) throw new Error(`${channel}_REPOSITORY_UNBOUNDED_RESULT`)
  return rows
}

function validateSemanticRow(row, expectedIdentity) {
  const identity = validateEmbeddingIdentity(expectedIdentity)
  if (row?.rollout_status !== "active") throw new Error("SEMANTIC_EMBEDDING_NOT_ACTIVE")
  if (String(row.provider || "") !== identity.providerId
    || String(row.model || "") !== identity.modelId
    || String(row.embedding_version || "") !== identity.version
    || String(row.preprocessor_version || "") !== identity.preprocessorVersion
    || Number(row.dimensions) !== identity.dimension) throw new Error("SEMANTIC_EMBEDDING_IDENTITY_MISMATCH")
  return row
}

function eventTimestamp(candidate) {
  for (const value of [candidate.event_time, candidate.valid_from, candidate.created_at]) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function scoreRecency(candidate, retrievalTime) {
  const event = eventTimestamp(candidate)
  const now = Date.parse(retrievalTime)
  if (event === null || !Number.isFinite(now)) return 0.35
  const ageDays = Math.max(0, (now - event) / 86_400_000)
  return round(0.2 + 0.8 * Math.exp(-ageDays / 730))
}

function signalMode(candidate) {
  const lexical = candidate.lexical_score > 0
  const semantic = candidate.semantic_available === true && candidate.semantic_score !== null
  if (lexical && semantic) return "hybrid"
  if (semantic) return "semantic_only"
  return "lexical_only"
}

function relevanceScore(candidate, mode) {
  if (mode === "hybrid") return 0.52 * clamp01(candidate.lexical_score) + 0.48 * clamp01(candidate.semantic_score)
  if (mode === "semantic_only") return clamp01(candidate.semantic_score)
  return clamp01(candidate.lexical_score)
}

export function rankEligibleCandidate(candidate, context = {}, policy = XIAOC_MEMORY_RETRIEVAL_POLICY) {
  if (candidate?.eligibility?.eligible !== true) throw new Error("RANKING_REQUIRES_ELIGIBLE_CANDIDATE")
  const mode = signalMode(candidate)
  const relevance = relevanceScore(candidate, mode)
  const importance = clamp01(clamp01(Number(candidate.importance) / 10))
  const recency = scoreRecency(candidate, context.retrievalTime)
  const authority = candidate.eligibility.authority === "native_verified" ? 1 : 0.35
  const historical = candidate.eligibility.temporal_state === "expired" || candidate.eligibility.temporal_state === "resolved"
  const recall = context.explicitRecall === true || (context.mode === "historical_recall" && historical) ? 1 : 0
  const hybrid = round(
    relevance * policy.weights.relevance
    + importance * policy.weights.importance
    + recency * policy.weights.recency
    + authority * policy.weights.authority
    + recall * policy.weights.recall,
  )
  const threshold = policy.thresholds[mode]
  const passesThreshold = relevance >= threshold
  const reasons = [
    `SIGNAL_MODE_${mode.toUpperCase()}`,
    ...(candidate.lexical_score > 0 ? ["LEXICAL_SIGNAL"] : []),
    ...(candidate.semantic_available ? ["SEMANTIC_SIGNAL"] : ["SEMANTIC_UNAVAILABLE"]),
    ...(context.explicitRecall === true ? ["EXPLICIT_RECALL_BOOST"] : []),
    ...(context.mode === "historical_recall" && historical ? ["HISTORICAL_RECALL_BOOST"] : []),
    passesThreshold ? "RELEVANCE_THRESHOLD_PASSED" : "RELEVANCE_THRESHOLD_NOT_MET",
  ]
  return {
    candidate,
    signal_mode: mode,
    component_scores: {
      lexical: round(clamp01(candidate.lexical_score)),
      semantic: candidate.semantic_available ? round(clamp01(candidate.semantic_score)) : null,
      relevance: round(relevance),
      importance: round(importance),
      recency,
      authority: round(authority),
      explicit_recall: recall,
    },
    hybrid_score: hybrid,
    threshold,
    passes_threshold: passesThreshold,
    selection_reason_codes: reasons,
  }
}

function rankingOrder(left, right) {
  return right.hybrid_score - left.hybrid_score
    || right.component_scores.relevance - left.component_scores.relevance
    || right.component_scores.lexical - left.component_scores.lexical
    || (right.component_scores.semantic ?? -1) - (left.component_scores.semantic ?? -1)
    || right.component_scores.authority - left.component_scores.authority
    || right.component_scores.recency - left.component_scores.recency
    || right.component_scores.importance - left.component_scores.importance
    || String(left.candidate.memory_id).localeCompare(String(right.candidate.memory_id))
}

function structuredResult(ranked) {
  const candidate = ranked.candidate
  return {
    memory_id: candidate.memory_id,
    user_id: candidate.user_id,
    provenance_status: candidate.provenance_status,
    authority_tier: candidate.authority_tier,
    retrieval_tier: candidate.retrieval_tier,
    lifecycle_status: candidate.lifecycle_status,
    legacy_limited: candidate.eligibility.legacy_limited,
    claim_key: candidate.claim_key,
    temporal_state: candidate.eligibility.temporal_state,
    lexical_score: ranked.component_scores.lexical,
    semantic_score: ranked.component_scores.semantic,
    semantic_available: candidate.semantic_available,
    importance_score: ranked.component_scores.importance,
    recency_score: ranked.component_scores.recency,
    authority_score: ranked.component_scores.authority,
    relevance_score: ranked.component_scores.relevance,
    hybrid_score: ranked.hybrid_score,
    selection_reason_codes: ranked.selection_reason_codes,
    event_time: candidate.event_time ?? null,
    valid_from: candidate.valid_from ?? null,
    valid_until: candidate.valid_until ?? null,
    created_at: candidate.created_at ?? null,
  }
}

function dedupeAndSelect(ranked, topK, legacyLimit) {
  const selected = []
  const identities = new Set()
  let legacyCount = 0
  for (const item of ranked) {
    const candidate = item.candidate
    const identity = candidate.claim_key ? `claim:${candidate.claim_key}` : candidate.content_hash ? `hash:${candidate.content_hash}` : `id:${candidate.memory_id}`
    if (identities.has(identity)) continue
    if (candidate.eligibility.legacy_limited && legacyCount >= legacyLimit) continue
    identities.add(identity)
    if (candidate.eligibility.legacy_limited) legacyCount += 1
    selected.push(structuredResult(item))
    if (selected.length >= topK) break
  }
  return selected
}

function countReasons(items) {
  const counts = {}
  for (const item of items) {
    for (const reason of item.eligibility?.reason_codes || []) counts[reason] = (counts[reason] || 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

export async function generateBoundedCandidates({ repository, userId, query, queryEmbedding = null, embeddingIdentity = null, channelMode = "hybrid", policy = XIAOC_MEMORY_RETRIEVAL_POLICY }) {
  if (!repository?.listLexicalCandidates) throw new Error("BOUNDED_LEXICAL_REPOSITORY_REQUIRED")
  if (!["hybrid", "lexical_only", "semantic_only"].includes(channelMode)) throw new Error("RETRIEVAL_CHANNEL_MODE_INVALID")
  const lexicalEnabled = channelMode !== "semantic_only"
  const lexicalPromise = lexicalEnabled ? repository.listLexicalCandidates({ userId, query, limit: policy.lexicalCandidateLimit }) : Promise.resolve([])
  const semanticEnabled = channelMode !== "lexical_only" && queryEmbedding !== null && typeof repository.listSemanticCandidates === "function"
  if (semanticEnabled) validateEmbeddingIdentity(embeddingIdentity)
  const semanticPromise = semanticEnabled
    ? repository.listSemanticCandidates({ userId, queryEmbedding, embeddingIdentity, limit: policy.semanticCandidateLimit })
    : Promise.resolve([])
  const [lexicalRowsRaw, semanticRowsRaw] = await Promise.all([lexicalPromise, semanticPromise])
  const lexicalRows = boundedRows(lexicalRowsRaw, policy.lexicalCandidateLimit, "LEXICAL")
  const semanticRows = boundedRows(semanticRowsRaw, policy.semanticCandidateLimit, "SEMANTIC").map((row) => validateSemanticRow(row, embeddingIdentity))
  const merged = new Map()
  for (const row of lexicalRows) merged.set(itemId(row), { memory: memoryOf(row), memoryEmbedding: null })
  for (const row of semanticRows) {
    const id = itemId(row)
    const existing = merged.get(id)
    merged.set(id, { memory: existing?.memory || memoryOf(row), memoryEmbedding: row.memory_embedding ?? row.embedding ?? row.vector ?? null })
  }
  const candidates = [...merged.values()].map(({ memory, memoryEmbedding }) => buildHybridCandidate({
    memory, userId, query, queryEmbedding: memoryEmbedding === null ? null : queryEmbedding, memoryEmbedding,
  })).map((candidate) => channelMode === "semantic_only" ? {
    ...candidate,
    lexical_score: 0,
    lexical_reason_codes: ["LEXICAL_CHANNEL_DISABLED"],
    lexical_components: { exact: 0, substring: 0, tokenOverlap: 0, characterNgramOverlap: 0, numericEntityOverlap: 0 },
  } : candidate)
  candidates.sort((left, right) => Math.max(right.lexical_score, right.semantic_score ?? -1) - Math.max(left.lexical_score, left.semantic_score ?? -1)
    || String(left.memory_id).localeCompare(String(right.memory_id)))
  return {
    candidates: candidates.slice(0, policy.combinedCandidateLimit),
    channel_counts: { lexical: lexicalRows.length, semantic: semanticRows.length, union: merged.size },
    degradation_mode: channelMode === "semantic_only" ? "SEMANTIC_ONLY"
      : semanticEnabled && semanticRows.length > 0 ? "HYBRID_AVAILABLE" : "LEXICAL_ONLY",
  }
}

export async function retrieveXiaoCMemoriesOffline({
  repository, userId, query, queryEmbedding = null, embeddingIdentity = null, relations = null,
  externalClaims = [], retrievalTime = new Date().toISOString(), mode = "normal_current",
  explicitRecall = false, topK = XIAOC_MEMORY_RETRIEVAL_POLICY.defaultTopK, policy = XIAOC_MEMORY_RETRIEVAL_POLICY,
  channelMode = "hybrid",
  retrievalContext = {},
} = {}) {
  if (!userId) throw new Error("USER_ID_REQUIRED")
  const started = performance.now()
  const requestedTopK = Math.max(0, Math.min(policy.maximumTopK, Number.isInteger(topK) ? topK : policy.defaultTopK))
  const queryPlan = buildXiaoCMemoryQueryPlan(query, { explicitRecall, mode, grounding: retrievalContext.grounding })
  if (!queryPlan.should_retrieve || requestedTopK === 0) return {
    results: [],
    trace: { policy_version: policy.version, query_plan: { version: queryPlan.version, should_retrieve: false, grounding_strength: queryPlan.grounding_strength, reason_codes: queryPlan.reason_codes }, raw_candidate_count: 0, eligible_count: 0, suppressed_count: 0, ranked_count: 0, selected_count: 0, threshold_rejected_count: 0, degradation_mode: "NO_QUERY", reason_code_counts: {}, latency_ms: { total: round(performance.now() - started) } },
  }
  const generated = await generateBoundedCandidates({ repository, userId, query: queryPlan.retrieval_query, queryEmbedding, embeddingIdentity, channelMode, policy })
  const candidateIds = generated.candidates.map((item) => item.memory_id)
  const relationRows = relations ?? (repository.listRelations ? await repository.listRelations({ userId, memoryIds: candidateIds }) : [])
  const resolved = resolveOfflineCandidateEligibility({ candidates: generated.candidates, relations: relationRows, userId, retrievalTime, mode, externalClaims })
  const strongestLexical = Math.max(0, ...resolved.eligible_candidates.map((candidate) => candidate.lexical_score || 0))
  const compatibilityRejected = []
  const compatible = resolved.eligible_candidates.filter((candidate) => {
    const semanticOnly = candidate.semantic_available && candidate.semantic_score !== null && candidate.lexical_score <= 0
    if (!semanticOnly) return true
    const grounded = queryPlan.grounding_strength === "STRONG" && (queryPlan.trusted_explicit_recall || queryPlan.grounding_anchor_count > 0)
    const displacedByLexicalEvidence = strongestLexical >= policy.semanticAdmission.conflictingLexicalFloor
    const admitted = grounded && candidate.semantic_score >= policy.semanticAdmission.groundedMinimum && !displacedByLexicalEvidence
    if (!admitted) compatibilityRejected.push({ memory_id: candidate.memory_id, reason_codes: [
      ...(!grounded ? ["SEMANTIC_ONLY_UNGROUNDED"] : []),
      ...(candidate.semantic_score < policy.semanticAdmission.groundedMinimum ? ["SEMANTIC_ONLY_BELOW_GROUNDED_FLOOR"] : []),
      ...(displacedByLexicalEvidence ? ["SEMANTIC_CONFLICTS_WITH_STRONG_LEXICAL_EVIDENCE"] : []),
    ] })
    return admitted
  })
  const ranked = compatible.map((candidate) => rankEligibleCandidate(candidate, { retrievalTime, mode, explicitRecall: queryPlan.explicit_recall }, policy)).sort(rankingOrder)
  const passing = ranked.filter((item) => item.passes_threshold)
  const results = dedupeAndSelect(passing, requestedTopK, policy.legacySlotLimit)
  return {
    results,
    trace: {
      policy_version: policy.version,
      query_plan: { version: queryPlan.version, should_retrieve: true, grounding_strength: queryPlan.grounding_strength, explicit_recall: queryPlan.explicit_recall, lexical_term_count: queryPlan.lexical_terms.length, entity_like_term_count: queryPlan.entity_like_terms.length, reason_codes: queryPlan.reason_codes },
      channel_candidate_counts: generated.channel_counts,
      raw_candidate_count: generated.candidates.length,
      eligible_count: resolved.eligible_candidates.length,
      suppressed_count: resolved.suppressed_candidates.length,
      ranked_count: ranked.length,
      selected_count: results.length,
      threshold_rejected_count: ranked.length - passing.length,
      degradation_mode: generated.degradation_mode,
      reason_code_counts: countReasons(resolved.suppressed_candidates),
      compatibility_rejections: compatibilityRejected,
      suppressed_candidates: resolved.suppressed_candidates.map((item) => ({ memory_id: item.memory_id, reason_codes: item.eligibility.reason_codes, suppressed_by: item.eligibility.suppressed_by, temporal_state: item.eligibility.temporal_state })),
      ranking_decisions: ranked.map((item) => ({ memory_id: item.candidate.memory_id, component_scores: item.component_scores, hybrid_score: item.hybrid_score, threshold: item.threshold, passes_threshold: item.passes_threshold, reason_codes: item.selection_reason_codes })),
      latency_ms: { total: round(performance.now() - started) },
    },
  }
}

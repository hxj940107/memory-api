import { evaluateContextCandidates } from "./contextEligibility.js"
import { isXiaoCMemorySemanticRetrievalEnabled, XIAOC_MEMORY_EMBEDDING_IDENTITY } from "./aiConfig.js"
import { consumeMemoryContextBudget, createMemoryContextBudget } from "./memoryContextGateway.js"
import { buildXiaoCMemoryQueryPlan } from "./xiaocMemoryQueryPlan.js"
import { XiaoCMemoryDbRetrievalRepository } from "./xiaocMemoryDbRepository.js"
import {
  XIAOC_MEMORY_RETRIEVAL_POLICY,
  retrieveXiaoCMemoriesOffline,
} from "./xiaocMemoryRanking.js"

export const XIAOC_OWNED_MEMORY_PROMPT_READY_TOP_K = 3

function compactOwnedMemoryForBudget(candidate, maxChars) {
  const content = String(candidate?.content || "").trim()
  const bounded = Math.max(0, Number(maxChars) || 0)
  if (!content || bounded <= 0 || content.length <= bounded) return null
  const firstCompleteSentence = content.match(/[^。！？!?\n]+[。！？!?]+/u)?.[0]?.trim()
  if (firstCompleteSentence && firstCompleteSentence.length <= bounded) {
    return { content: firstCompleteSentence, representation: "compact_complete_sentence" }
  }
  const firstCompleteLine = content.split(/\r?\n/u).map(line => line.trim()).find(Boolean)
  if (firstCompleteLine && firstCompleteLine.length <= bounded) {
    return { content: firstCompleteLine, representation: "compact_complete_line" }
  }
  return null
}

function ownedRepository(repository, contentById) {
  const allowed = row => {
    const memory = row?.memory || row
    return memory.origin_system === "xiaoc_native" || (
      memory.origin_system === "ombre_legacy" && memory.lifecycle_status === "active"
      && memory.provenance_status === "legacy_unverified" && memory.retrieval_tier === "low_authority"
      && memory.authority_tier === "legacy_limited"
    )
  }
  const remember = row => {
    const memory = row?.memory || row
    contentById.set(String(memory.id || memory.memory_id), String(memory.canonical_content || ""))
    return row
  }
  return {
    async listLexicalCandidates(args) {
      const rows = await repository.listLexicalCandidates(args)
      return rows.filter(allowed).map(remember)
    },
    async listSemanticCandidates(args) {
      if (typeof repository.listSemanticCandidates !== "function") return []
      return (await repository.listSemanticCandidates(args)).filter(allowed).map(remember)
    },
    async listRelations(args) {
      return typeof repository.listRelations === "function" ? repository.listRelations(args) : []
    },
  }
}

function safePromptCandidate(result, contentById) {
  const content = contentById.get(String(result.memory_id)) || ""
  const trustedNative = result.authority_tier === "native_verified"
    && result.provenance_status === "verified_user"
  const approvedLegacy = result.authority_tier === "legacy_limited"
    && result.provenance_status === "legacy_unverified"
    && result.retrieval_tier === "low_authority"
  if (!content || result.lifecycle_status !== "active" || (!trustedNative && !approvedLegacy)) return null
  return {
    content,
    memoryId: result.memory_id,
    candidateId: `xiaoc-owned-${result.memory_id}`,
    source: approvedLegacy ? "xiaoc_owned_legacy_limited" : "xiaoc_owned_native",
    semanticRelevance: result.relevance_score,
    retrievalScore: result.hybrid_score,
  }
}

export async function retrieveOwnedMemoryPromptCandidatesShadow({
  client,
  repository = null,
  userId,
  query,
  retrievalTime = new Date().toISOString(),
  context = {},
  memoryBudget = null,
  maxChars = Infinity,
  shadowOnly = true,
  env = process.env,
  embeddingProvider = null,
} = {}) {
  const contentById = new Map()
  const source = repository || new XiaoCMemoryDbRetrievalRepository(client, {
    retrievalMode: "normal_current",
    retrievalTime,
  })
  const semanticEnabled = isXiaoCMemorySemanticRetrievalEnabled(env) && embeddingProvider
  const queryPlan = buildXiaoCMemoryQueryPlan(query)
  let queryEmbedding = null
  let embeddingErrorCode = null
  if (semanticEnabled && queryPlan.should_retrieve) {
    try { [queryEmbedding] = await embeddingProvider.embed([queryPlan.retrieval_query]) } catch (error) {
      embeddingErrorCode = String(error?.code || error?.message || "QUERY_EMBEDDING_FAILED").split(":")[0].slice(0, 80)
    }
  }
  const retrieval = await retrieveXiaoCMemoriesOffline({
    repository: ownedRepository(source, contentById),
    userId,
    query,
    retrievalTime,
    mode: "normal_current",
    explicitRecall: false,
    topK: XIAOC_OWNED_MEMORY_PROMPT_READY_TOP_K,
    queryEmbedding,
    embeddingIdentity: queryEmbedding ? XIAOC_MEMORY_EMBEDDING_IDENTITY : null,
    channelMode: queryEmbedding ? "hybrid" : "lexical_only",
  })
  const rankedPool = Array.isArray(retrieval.selection_pool) ? retrieval.selection_pool : retrieval.results
  const candidates = rankedPool.map(result => safePromptCandidate(result, contentById)).filter(Boolean)
  const remainingChars = memoryBudget
    ? Math.max(0, Number(memoryBudget.remainingChars) || 0)
    : Math.max(0, Number(maxChars) || 0)
  const shadowBudget = createMemoryContextBudget(remainingChars)
  const gateway = evaluateContextCandidates(candidates, context, {
    maxChars: shadowBudget.remainingChars,
    maxInjected: XIAOC_OWNED_MEMORY_PROMPT_READY_TOP_K,
    minimumRelevance: null,
    compactForBudget: compactOwnedMemoryForBudget,
  })
  const promptReadyCandidates = gateway.injected.slice(0, XIAOC_OWNED_MEMORY_PROMPT_READY_TOP_K)
  consumeMemoryContextBudget(shadowBudget, promptReadyCandidates.map(item => item.content))
  if (!shadowOnly) {
    consumeMemoryContextBudget(memoryBudget, promptReadyCandidates.map(item => item.content))
  }
  const readyIds = new Set(promptReadyCandidates.map(item => item.candidateId))
  const diagnostics = gateway.diagnostics.map(item => ({
    ...item,
    would_be_prompt_ready: readyIds.has(item.candidate_id),
    eligible_for_prompt: shadowOnly ? false : item.eligible_for_prompt,
    injected: shadowOnly ? false : readyIds.has(item.candidate_id),
  }))
  return {
    retrieval,
    promptReadyCandidates,
    diagnostics,
    telemetry: {
      retrieved_count: retrieval.trace?.raw_candidate_count || 0,
      selected_count: candidates.length,
      prompt_ready_count: promptReadyCandidates.length,
      suppressed_count: diagnostics.filter(item => !item.would_be_prompt_ready).length,
      used_chars: promptReadyCandidates.reduce((sum, item) => sum + item.content.length, 0),
      remaining_budget_chars: shadowBudget.remainingChars,
      channel_mode: queryEmbedding ? "HYBRID" : "LEXICAL_ONLY",
      requested_channel_mode: semanticEnabled ? "HYBRID" : "LEXICAL_ONLY",
      degradation_mode: retrieval.trace?.degradation_mode || "LEXICAL_ONLY",
      semantic_error_code: embeddingErrorCode || retrieval.trace?.semantic_error_code || null,
      top_k: XIAOC_OWNED_MEMORY_PROMPT_READY_TOP_K,
      injected: !shadowOnly && promptReadyCandidates.length > 0,
      trace: {
        candidates: (retrieval.trace?.ranking_decisions || []).map((item, index) => ({
          memory_id: item.memory_id, channel: item.component_scores?.semantic === null ? "lexical" : item.component_scores?.lexical > 0 ? "hybrid" : "semantic",
          rank: index + 1,
          lexical_score: item.component_scores?.lexical ?? null,
          semantic_score: item.component_scores?.semantic ?? null,
          final_score: item.hybrid_score,
          threshold: item.threshold,
          stage: item.passes_threshold ? "ranked" : "threshold_rejected",
          reason_codes: item.reason_codes || [],
        })),
        admission_rejected: (retrieval.trace?.compatibility_rejections || []).map(item => ({
          memory_id: item.memory_id,
          stage: "semantic_admission_rejected",
          signal_mode: item.signal_mode,
          lexical_score: item.lexical_score,
          semantic_score: item.semantic_score,
          semantic_grounded_floor: item.semantic_grounded_floor,
          reason_codes: item.reason_codes,
        })),
        suppressed: (retrieval.trace?.suppressed_candidates || []).map(item => ({ memory_id: item.memory_id, stage: "eligibility_or_relation", reason_codes: item.reason_codes })),
        gateway: diagnostics.map(item => ({ memory_id: item.memory_id, stage: item.injected ? "injected" : "gateway_suppressed", suppression_reason: item.suppression_reason })),
      },
    },
  }
}

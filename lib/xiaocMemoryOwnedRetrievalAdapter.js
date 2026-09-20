import { evaluateContextCandidates } from "./contextEligibility.js"
import { consumeMemoryContextBudget, createMemoryContextBudget } from "./memoryContextGateway.js"
import { XiaoCMemoryDbRetrievalRepository } from "./xiaocMemoryDbRepository.js"
import {
  XIAOC_MEMORY_RETRIEVAL_POLICY,
  retrieveXiaoCMemoriesOffline,
} from "./xiaocMemoryRanking.js"

export const XIAOC_OWNED_MEMORY_PROMPT_READY_TOP_K = 3

function ownedRepository(repository, contentById) {
  return {
    async listLexicalCandidates(args) {
      const rows = await repository.listLexicalCandidates(args)
      return rows.filter(row => row.origin_system === "xiaoc_native").map(row => {
        contentById.set(String(row.id || row.memory_id), String(row.canonical_content || ""))
        return row
      })
    },
    async listRelations(args) {
      return typeof repository.listRelations === "function" ? repository.listRelations(args) : []
    },
  }
}

function safePromptCandidate(result, contentById) {
  const content = contentById.get(String(result.memory_id)) || ""
  if (!content || result.lifecycle_status !== "active" || result.authority_tier !== "native_verified") return null
  return {
    content,
    memoryId: result.memory_id,
    candidateId: `xiaoc-owned-${result.memory_id}`,
    source: "xiaoc_owned_shadow",
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
} = {}) {
  const contentById = new Map()
  const source = repository || new XiaoCMemoryDbRetrievalRepository(client, {
    retrievalMode: "normal_current",
    retrievalTime,
  })
  const retrieval = await retrieveXiaoCMemoriesOffline({
    repository: ownedRepository(source, contentById),
    userId,
    query,
    retrievalTime,
    mode: "normal_current",
    explicitRecall: false,
    topK: XIAOC_OWNED_MEMORY_PROMPT_READY_TOP_K,
    channelMode: "lexical_only",
  })
  const candidates = retrieval.results.map(result => safePromptCandidate(result, contentById)).filter(Boolean)
  const remainingChars = memoryBudget
    ? Math.max(0, Number(memoryBudget.remainingChars) || 0)
    : Math.max(0, Number(maxChars) || 0)
  const shadowBudget = createMemoryContextBudget(remainingChars)
  const gateway = evaluateContextCandidates(candidates, context, {
    maxChars: shadowBudget.remainingChars,
    minimumRelevance: XIAOC_MEMORY_RETRIEVAL_POLICY.thresholds.lexical_only,
  })
  const promptReadyCandidates = gateway.injected.slice(0, XIAOC_OWNED_MEMORY_PROMPT_READY_TOP_K)
  consumeMemoryContextBudget(shadowBudget, promptReadyCandidates.map(item => item.content))
  const readyIds = new Set(promptReadyCandidates.map(item => item.candidateId))
  const diagnostics = gateway.diagnostics.map(item => ({
    ...item,
    would_be_prompt_ready: readyIds.has(item.candidate_id),
    eligible_for_prompt: false,
    injected: false,
  }))
  return {
    retrieval,
    promptReadyCandidates,
    diagnostics,
    telemetry: {
      retrieved_count: retrieval.trace?.raw_candidate_count || 0,
      selected_count: retrieval.results.length,
      prompt_ready_count: promptReadyCandidates.length,
      suppressed_count: diagnostics.filter(item => !item.would_be_prompt_ready).length,
      used_chars: promptReadyCandidates.reduce((sum, item) => sum + item.content.length, 0),
      remaining_budget_chars: shadowBudget.remainingChars,
      channel_mode: "LEXICAL_ONLY",
      top_k: XIAOC_OWNED_MEMORY_PROMPT_READY_TOP_K,
      injected: false,
    },
  }
}

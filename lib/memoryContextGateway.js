import { evaluateContextCandidates } from "./contextEligibility.js"
import { evaluateDynamicMemorySearchText } from "./dynamicMemoryFilter.js"

export function logMemoryContextDiagnostics(label, conversationId, diagnostics, logger = console) {
  logger.log(`${label} MEMORY ELIGIBILITY:`, {
    conversation_id: conversationId,
    candidates: diagnostics,
  })
}

export function prepareStableMemoryCandidates(rows) {
  const supersededStableIds = new Set(
    (rows || []).map(item => item.metadata?.supersedes_stable_id)
      .filter(Boolean)
      .map(String)
  )
  return (rows || []).filter(item => (
    item.metadata?.type !== "episodic"
    && !supersededStableIds.has(String(item.id))
  )).map(item => ({
    content: String(item.content || "").trim(),
    memoryId: item.id,
    candidateId: `stable-${item.id}`,
    source: "stable",
    createdAt: item.created_at,
    conversationId: item.metadata?.source_conversation_id
      || item.metadata?.conversation_id
      || null,
    conversationIds: Array.isArray(item.metadata?.source_conversation_ids)
      ? item.metadata.source_conversation_ids
      : [],
    semanticRelevance: item.metadata?.semantic_relevance
      ?? item.metadata?.relevance
      ?? null,
  })).filter(item => item.content)
}

export function createMemoryContextBudget(maxChars) {
  return {
    maxChars: Math.max(0, Number(maxChars) || 0),
    usedChars: 0,
    get remainingChars() {
      return Math.max(0, this.maxChars - this.usedChars)
    },
  }
}

function availableMemoryChars(maxChars, budget) {
  const requested = Number.isFinite(Number(maxChars)) ? Number(maxChars) : Infinity
  return budget ? Math.min(requested, budget.remainingChars) : requested
}

export function consumeMemoryContextBudget(budget, values) {
  if (!budget) return
  budget.usedChars += (values || []).reduce(
    (total, value) => total + String(value || "").length,
    0
  )
}

export function selectStableMemoryContext({
  candidates,
  context,
  maxChars,
  minimumRelevance = null,
  budget = null,
  logger = console,
}) {
  const result = evaluateContextCandidates(
    candidates,
    context,
    { maxChars: availableMemoryChars(maxChars, budget), minimumRelevance }
  )
  logMemoryContextDiagnostics(
    "STABLE",
    context.currentConversationId,
    result.diagnostics,
    logger
  )
  const memories = result.injected.map(item => item.content)
  consumeMemoryContextBudget(budget, memories)
  return {
    memories,
    diagnostics: result.diagnostics,
  }
}

export function selectDynamicMemoryContext({
  searchText,
  excludedMemories,
  context,
  maxChars,
  minimumRelevance = null,
  budget = null,
  logger = console,
}) {
  const result = evaluateDynamicMemorySearchText(searchText, excludedMemories, {
    ...context,
    maxChars: availableMemoryChars(maxChars, budget),
    minimumRelevance,
  })
  logMemoryContextDiagnostics(
    "DYNAMIC",
    context.currentConversationId,
    result.diagnostics,
    logger
  )
  consumeMemoryContextBudget(budget, result.injected?.map(item => item.content) || [])
  return result
}

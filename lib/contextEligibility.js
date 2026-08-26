import { isContextuallyDuplicate } from "./mainChatContext.js"

export const CONTEXT_ELIGIBILITY_REASONS = Object.freeze({
  DUPLICATE_RECENT: "duplicate_recent",
  DUPLICATE_ACTIVE: "duplicate_active",
  DUPLICATE_SUMMARY: "duplicate_summary",
  DUPLICATE_CORE: "duplicate_core",
  RECENTLY_CREATED: "recently_created",
  DUPLICATE_DYNAMIC: "duplicate_dynamic",
  LOW_RELEVANCE: "low_relevance",
  BUDGET_EXCEEDED: "budget_exceeded",
  INJECTED: "injected",
  USER_REMENTION_OVERRIDE: "user_remention_override",
})

function compactId(value) {
  const text = String(value || "").trim()
  return text || null
}

function numericRelevance(value) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function matchesAny(content, texts) {
  return (texts || []).some(text => isContextuallyDuplicate(content, text))
}

function isUserRemention(content, currentMessage) {
  if (!currentMessage) return false
  if (isContextuallyDuplicate(content, currentMessage)) return true

  // Stored memory uses XiaoC's relationship perspective ("她"), while the
  // user's current message naturally uses first person. Compare that one
  // deterministic perspective variant without involving another model call.
  const firstPersonVariant = String(content || "")
    .replace(/用户/g, "我")
    .replace(/她/g, "我")
  return isContextuallyDuplicate(firstPersonVariant, currentMessage)
}

function normalizeCandidate(candidate, index) {
  const content = String(candidate?.content ?? candidate ?? "").trim()
  return {
    ...candidate,
    content,
    memoryId: compactId(candidate?.memoryId),
    bucketId: compactId(candidate?.bucketId),
    candidateId: compactId(candidate?.candidateId) || `candidate-${index + 1}`,
    source: String(candidate?.source || "memory"),
    semanticRelevance: numericRelevance(candidate?.semanticRelevance),
    conversationId: compactId(candidate?.conversationId),
    conversationIds: Array.isArray(candidate?.conversationIds)
      ? candidate.conversationIds.map(compactId).filter(Boolean)
      : [],
  }
}

function traceFor(candidate, reason, userRementionedNow) {
  const injected = reason === CONTEXT_ELIGIBILITY_REASONS.INJECTED
    || reason === CONTEXT_ELIGIBILITY_REASONS.USER_REMENTION_OVERRIDE
  return {
    memory_id: candidate.memoryId,
    bucket_id: candidate.bucketId,
    candidate_id: candidate.candidateId,
    candidate_source: candidate.source,
    semantic_relevance: candidate.semanticRelevance,
    injected,
    suppressed: !injected,
    suppression_reason: reason,
    user_rementioned_now: userRementionedNow,
  }
}

/**
 * Deterministic eligibility for long-term memory injection. This function only
 * selects prompt context; its result must never create, refresh, or prolong
 * Active Conversation Context.
 */
export function evaluateContextCandidates(candidates, context = {}, options = {}) {
  const injected = []
  const diagnostics = []
  const seen = []
  const currentConversationId = compactId(context.currentConversationId)
  const minimumRelevance = numericRelevance(options.minimumRelevance)
  const maxChars = Number.isFinite(Number(options.maxChars))
    ? Math.max(0, Number(options.maxChars))
    : Infinity
  let usedChars = 0

  for (const [index, rawCandidate] of (candidates || []).entries()) {
    const candidate = normalizeCandidate(rawCandidate, index)
    if (!candidate.content) continue

    const userRementionedNow = isUserRemention(
      candidate.content,
      context.currentMessage
    )
    let reason = null

    if (seen.some(content => isContextuallyDuplicate(candidate.content, content))) {
      reason = CONTEXT_ELIGIBILITY_REASONS.DUPLICATE_DYNAMIC
    } else if (
      candidate.duplicateWithCore
      || matchesAny(candidate.content, context.coreTexts)
    ) {
      reason = CONTEXT_ELIGIBILITY_REASONS.DUPLICATE_CORE
    } else if (matchesAny(candidate.content, context.recentTexts)) {
      reason = CONTEXT_ELIGIBILITY_REASONS.DUPLICATE_RECENT
    } else if (matchesAny(candidate.content, context.activeTexts)) {
      reason = CONTEXT_ELIGIBILITY_REASONS.DUPLICATE_ACTIVE
    } else if (matchesAny(candidate.content, context.summaryTexts)) {
      reason = CONTEXT_ELIGIBILITY_REASONS.DUPLICATE_SUMMARY
    } else if (
      currentConversationId
      && (
        candidate.conversationId === currentConversationId
        || candidate.conversationIds.includes(currentConversationId)
      )
    ) {
      reason = CONTEXT_ELIGIBILITY_REASONS.RECENTLY_CREATED
    } else if (
      minimumRelevance !== null
      && candidate.semanticRelevance !== null
      && candidate.semanticRelevance < minimumRelevance
    ) {
      reason = CONTEXT_ELIGIBILITY_REASONS.LOW_RELEVANCE
    }

    if (
      userRementionedNow
      && reason
      && reason !== CONTEXT_ELIGIBILITY_REASONS.DUPLICATE_CORE
      && reason !== CONTEXT_ELIGIBILITY_REASONS.DUPLICATE_DYNAMIC
    ) {
      reason = CONTEXT_ELIGIBILITY_REASONS.USER_REMENTION_OVERRIDE
    }

    if (!reason && usedChars + candidate.content.length > maxChars) {
      reason = CONTEXT_ELIGIBILITY_REASONS.BUDGET_EXCEEDED
    }
    if (!reason) reason = CONTEXT_ELIGIBILITY_REASONS.INJECTED

    diagnostics.push(traceFor(candidate, reason, userRementionedNow))
    seen.push(candidate.content)

    if (
      reason === CONTEXT_ELIGIBILITY_REASONS.INJECTED
      || reason === CONTEXT_ELIGIBILITY_REASONS.USER_REMENTION_OVERRIDE
    ) {
      injected.push(candidate)
      usedChars += candidate.content.length
    }
  }

  return { injected, diagnostics }
}

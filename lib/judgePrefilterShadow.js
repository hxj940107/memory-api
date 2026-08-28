const PURE_REACTION_PATTERN = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Punctuation}\p{Symbol}\s]+$/u
const LOW_INFORMATION_ACKNOWLEDGEMENTS = new Set([
  "嗯",
  "嗯嗯",
  "好",
  "好的",
  "好呀",
  "好哒",
  "行",
  "可以",
  "知道了",
  "收到",
  "哈哈",
  "哈哈哈",
  "嘿嘿",
])

function compact(value) {
  return String(value || "").replace(/\s+/g, "").trim()
}

function hasOpenCandidate(candidates = []) {
  return candidates.some(candidate => (
    candidate?.attention_status === "open"
    && !["completed", "cancelled"].includes(candidate?.state)
  ))
}

export function evaluateJudgePrefilterShadow({
  message,
  previousActiveContext,
  previousProactiveCandidates = [],
  contextualAssistantMessage = null,
} = {}) {
  const text = compact(message)

  if (!text) {
    return { would_skip: true, reason: "empty_message" }
  }
  if (hasOpenCandidate(previousProactiveCandidates)) {
    return { would_skip: false, reason: "open_candidate_present" }
  }
  if ((previousActiveContext?.items || []).length > 0) {
    return { would_skip: false, reason: "active_context_present" }
  }
  if (
    contextualAssistantMessage?.is_immediately_previous
    && /[?？]/.test(String(contextualAssistantMessage.content || ""))
  ) {
    return { would_skip: false, reason: "assistant_question_context" }
  }
  if (PURE_REACTION_PATTERN.test(text)) {
    return { would_skip: true, reason: "pure_reaction" }
  }
  if (LOW_INFORMATION_ACKNOWLEDGEMENTS.has(text)) {
    return { would_skip: true, reason: "closed_acknowledgement" }
  }
  return { would_skip: false, reason: "possible_context_or_event_update" }
}

function stableContext(context) {
  return JSON.stringify(context?.items || [])
}

export function completeJudgePrefilterShadow({
  prefilter,
  previousActiveContext,
  nextActiveContext,
  mergeDiagnostics,
} = {}) {
  const proposals = Array.isArray(mergeDiagnostics?.proposals)
    ? mergeDiagnostics.proposals
    : []
  const accepted = proposals.filter(item => item.admission_result === "accepted")
  const lifecycleUpdate = accepted.some(item => (
    item.merge_action === "merged_existing"
    || Boolean(item.matched_event_id)
  ))
  const temporalUpdate = accepted.some(item => (
    item.time_grounding_source
    && item.time_grounding_source !== "insufficient_time_evidence"
    && (
      item.utc_normalized_window?.start
      || item.utc_normalized_window?.end
    )
  ))
  const activeContextChanged = stableContext(previousActiveContext) !== stableContext(nextActiveContext)
  const dangerousFalseSkip = Boolean(
    prefilter?.would_skip
    && (
      accepted.length > 0
      || lifecycleUpdate
      || temporalUpdate
      || activeContextChanged
    )
  )

  return {
    prefilter_would_skip: Boolean(prefilter?.would_skip),
    prefilter_reason: prefilter?.reason || "not_evaluated",
    judge_actually_called: true,
    active_context_changed: activeContextChanged,
    proactive_proposal_produced: proposals.length > 0,
    proactive_proposal_accepted: accepted.length > 0,
    accepted_proposal_count: accepted.length,
    lifecycle_update: lifecycleUpdate,
    temporal_update: temporalUpdate,
    dangerous_false_skip: dangerousFalseSkip,
  }
}

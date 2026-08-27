import { isTerminalProactiveEventState } from "./proactiveAttentionCandidates.js"

export const PROACTIVE_ATTENTION_GATE_REASONS = Object.freeze({
  ELIGIBLE_SHADOW: "eligible_shadow",
  EVENT_MISSING: "event_missing",
  EVENT_COMPLETED: "event_completed",
  EVENT_CANCELLED: "event_cancelled",
  ATTENTION_CLOSED: "attention_closed",
  USER_ALREADY_UPDATED_RESULT: "user_already_updated_result",
  USER_REJECTED_TOPIC: "user_rejected_topic",
  ALREADY_PROACTIVELY_MENTIONED: "already_proactively_mentioned",
  OUTSIDE_EXPECTED_WINDOW: "outside_expected_window",
  ATTENTION_EXPIRED: "attention_expired",
  STALE_CANDIDATE: "stale_candidate",
  INVALID_SOURCE_PROVENANCE: "invalid_source_provenance",
  LOW_FOLLOW_UP_VALUE: "low_follow_up_value",
  IMMEDIATE_ROUTINE_EVENT: "immediate_routine_event",
  NOT_WORTH_INTERRUPTING_SILENCE: "not_worth_interrupting_silence",
  INSUFFICIENT_EVENT_SIGNIFICANCE: "insufficient_event_significance",
  CONVERSATION_MOVED_ON: "conversation_moved_on",
})

const DEFAULT_ATTENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_STALE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function validTime(value) {
  const time = value ? new Date(value).getTime() : NaN
  return Number.isFinite(time) ? time : null
}

function result(candidate, reason, eligible, evaluatedAt, rejectionType = null) {
  return {
    event_id: candidate?.event_id || null,
    eligible_for_proactive_attention: eligible,
    reason,
    confidence: eligible ? 0.8 : 1,
    hard_rejection: rejectionType === "hard",
    rejection_type: rejectionType,
    worthiness_reason: reason,
    evaluated_at: evaluatedAt,
  }
}

export function evaluateProactiveAttention(candidate, {
  now = new Date().toISOString(),
  userAlreadyUpdatedResult = false,
  userRejectedTopic = false,
  conversationMovedOn = false,
  attentionMaxAgeMs = DEFAULT_ATTENTION_MAX_AGE_MS,
  staleMaxAgeMs = DEFAULT_STALE_MAX_AGE_MS,
} = {}) {
  const evaluatedAt = new Date(now).toISOString()
  if (!candidate?.event_id) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.EVENT_MISSING, false, evaluatedAt, "hard")
  }

  const sources = Array.isArray(candidate.source_message_ids)
    ? candidate.source_message_ids.filter(Boolean).map(String)
    : []
  if (
    !sources.length
    || !candidate.last_user_update?.message_id
    || !sources.includes(String(candidate.last_user_update.message_id))
  ) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.INVALID_SOURCE_PROVENANCE, false, evaluatedAt, "hard")
  }
  if (candidate.state === "completed") {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.EVENT_COMPLETED, false, evaluatedAt, "hard")
  }
  if (candidate.state === "cancelled") {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.EVENT_CANCELLED, false, evaluatedAt, "hard")
  }
  if (isTerminalProactiveEventState(candidate.state) || candidate.attention_status === "closed") {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.ATTENTION_CLOSED, false, evaluatedAt, "hard")
  }
  if (userAlreadyUpdatedResult) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.USER_ALREADY_UPDATED_RESULT, false, evaluatedAt, "hard")
  }
  if (userRejectedTopic) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.USER_REJECTED_TOPIC, false, evaluatedAt, "hard")
  }
  if (candidate.last_proactive_mention?.created_at || candidate.last_proactive_mention?.message_id) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.ALREADY_PROACTIVELY_MENTIONED, false, evaluatedAt, "hard")
  }

  const nowTime = validTime(evaluatedAt)
  const windowStart = validTime(candidate.expected_window?.start)
  const windowEnd = validTime(candidate.expected_window?.end)
  if ((windowStart && nowTime < windowStart) || (windowEnd && nowTime > windowEnd)) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.OUTSIDE_EXPECTED_WINDOW, false, evaluatedAt, "hard")
  }

  const updatedAt = validTime(candidate.updated_at)
  if (!updatedAt) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.STALE_CANDIDATE, false, evaluatedAt, "hard")
  }
  const age = nowTime - updatedAt
  if (age > staleMaxAgeMs) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.STALE_CANDIDATE, false, evaluatedAt, "hard")
  }
  if (age > attentionMaxAgeMs) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.ATTENTION_EXPIRED, false, evaluatedAt, "hard")
  }

  const profile = candidate.follow_up_profile
  if (!profile) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.INSUFFICIENT_EVENT_SIGNIFICANCE, false, evaluatedAt, "semantic")
  }
  if (profile.routine && profile.immediate_continuation) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.IMMEDIATE_ROUTINE_EVENT, false, evaluatedAt, "semantic")
  }
  if (conversationMovedOn && profile.significance !== "high") {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.CONVERSATION_MOVED_ON, false, evaluatedAt, "semantic")
  }
  if (profile.significance === "low" && !profile.result_expected) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.LOW_FOLLOW_UP_VALUE, false, evaluatedAt, "semantic")
  }
  if (!profile.result_expected && profile.result_uncertainty === "none") {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.NOT_WORTH_INTERRUPTING_SILENCE, false, evaluatedAt, "semantic")
  }
  if (profile.significance === "low" && profile.result_uncertainty !== "meaningful") {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.INSUFFICIENT_EVENT_SIGNIFICANCE, false, evaluatedAt, "semantic")
  }

  return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.ELIGIBLE_SHADOW, true, evaluatedAt)
}

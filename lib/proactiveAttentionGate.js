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
})

const DEFAULT_ATTENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_STALE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function validTime(value) {
  const time = value ? new Date(value).getTime() : NaN
  return Number.isFinite(time) ? time : null
}

function result(candidate, reason, eligible, evaluatedAt) {
  return {
    event_id: candidate?.event_id || null,
    eligible_for_proactive_attention: eligible,
    reason,
    confidence: eligible ? 0.8 : 1,
    hard_rejection: !eligible,
    evaluated_at: evaluatedAt,
  }
}

export function evaluateProactiveAttention(candidate, {
  now = new Date().toISOString(),
  userAlreadyUpdatedResult = false,
  userRejectedTopic = false,
  attentionMaxAgeMs = DEFAULT_ATTENTION_MAX_AGE_MS,
  staleMaxAgeMs = DEFAULT_STALE_MAX_AGE_MS,
} = {}) {
  const evaluatedAt = new Date(now).toISOString()
  if (!candidate?.event_id) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.EVENT_MISSING, false, evaluatedAt)
  }

  const sources = Array.isArray(candidate.source_message_ids)
    ? candidate.source_message_ids.filter(Boolean).map(String)
    : []
  if (
    !sources.length
    || !candidate.last_user_update?.message_id
    || !sources.includes(String(candidate.last_user_update.message_id))
  ) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.INVALID_SOURCE_PROVENANCE, false, evaluatedAt)
  }
  if (candidate.state === "completed") {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.EVENT_COMPLETED, false, evaluatedAt)
  }
  if (candidate.state === "cancelled") {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.EVENT_CANCELLED, false, evaluatedAt)
  }
  if (isTerminalProactiveEventState(candidate.state) || candidate.attention_status === "closed") {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.ATTENTION_CLOSED, false, evaluatedAt)
  }
  if (userAlreadyUpdatedResult) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.USER_ALREADY_UPDATED_RESULT, false, evaluatedAt)
  }
  if (userRejectedTopic) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.USER_REJECTED_TOPIC, false, evaluatedAt)
  }
  if (candidate.last_proactive_mention?.created_at || candidate.last_proactive_mention?.message_id) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.ALREADY_PROACTIVELY_MENTIONED, false, evaluatedAt)
  }

  const nowTime = validTime(evaluatedAt)
  const windowStart = validTime(candidate.expected_window?.start)
  const windowEnd = validTime(candidate.expected_window?.end)
  if ((windowStart && nowTime < windowStart) || (windowEnd && nowTime > windowEnd)) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.OUTSIDE_EXPECTED_WINDOW, false, evaluatedAt)
  }

  const updatedAt = validTime(candidate.updated_at)
  if (!updatedAt) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.STALE_CANDIDATE, false, evaluatedAt)
  }
  const age = nowTime - updatedAt
  if (age > staleMaxAgeMs) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.STALE_CANDIDATE, false, evaluatedAt)
  }
  if (age > attentionMaxAgeMs) {
    return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.ATTENTION_EXPIRED, false, evaluatedAt)
  }

  return result(candidate, PROACTIVE_ATTENTION_GATE_REASONS.ELIGIBLE_SHADOW, true, evaluatedAt)
}

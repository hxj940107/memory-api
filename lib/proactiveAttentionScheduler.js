import {
  isOpenProactiveAttentionCandidate,
  isTerminalProactiveEventState,
} from "./proactiveAttentionCandidates.js"
import { evaluateProactiveAttention } from "./proactiveAttentionGate.js"

export const PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE = "proactive_attention_wakeup"
export const PROACTIVE_ATTENTION_WAKEUP_SOURCE_TYPE = "proactive_attention_event"

function validTime(value) {
  const time = value ? new Date(value).getTime() : NaN
  return Number.isFinite(time) ? time : null
}

function hasValidProvenance(candidate) {
  const sources = Array.isArray(candidate?.source_message_ids)
    ? candidate.source_message_ids.map(String)
    : []
  return Boolean(
    sources.length
    && candidate?.last_user_update?.message_id
    && sources.includes(String(candidate.last_user_update.message_id))
  )
}

export function planProactiveAttentionWakeup(candidate, {
  now = new Date().toISOString(),
} = {}) {
  const evaluatedAt = new Date(now).toISOString()
  if (!candidate?.event_id) {
    return { scheduled: false, reason: "event_missing", scheduled_for: null, evaluated_at: evaluatedAt }
  }
  if (
    isTerminalProactiveEventState(candidate.state)
    || candidate.attention_status === "closed"
  ) {
    return { scheduled: false, reason: "terminal_or_closed", scheduled_for: null, evaluated_at: evaluatedAt }
  }
  if (!isOpenProactiveAttentionCandidate(candidate) || !hasValidProvenance(candidate)) {
    return { scheduled: false, reason: "invalid_candidate", scheduled_for: null, evaluated_at: evaluatedAt }
  }

  const nowTime = validTime(evaluatedAt)
  const windowStart = validTime(candidate.expected_window?.start)
  const windowEnd = validTime(candidate.expected_window?.end)
  if (!windowStart && !windowEnd) {
    return { scheduled: false, reason: "expected_window_missing", scheduled_for: null, evaluated_at: evaluatedAt }
  }
  if (windowEnd && windowEnd < nowTime) {
    return { scheduled: false, reason: "expected_window_expired", scheduled_for: null, evaluated_at: evaluatedAt }
  }
  if (windowStart && windowStart > nowTime) {
    const futureGate = evaluateProactiveAttention(candidate, {
      now: new Date(windowStart).toISOString(),
    })
    if (!futureGate.eligible_for_proactive_attention) {
      return {
        scheduled: false,
        reason: futureGate.reason,
        scheduled_for: null,
        evaluated_at: evaluatedAt,
        gate: futureGate,
      }
    }
    return {
      scheduled: true,
      reason: "future_window_start",
      scheduled_for: new Date(windowStart).toISOString(),
      evaluated_at: evaluatedAt,
      gate: futureGate,
    }
  }

  const gate = evaluateProactiveAttention(candidate, { now: evaluatedAt })
  if (!gate.eligible_for_proactive_attention) {
    return {
      scheduled: false,
      reason: gate.reason,
      scheduled_for: null,
      evaluated_at: evaluatedAt,
      gate,
    }
  }
  return {
    scheduled: true,
    reason: "eligible_window_now",
    scheduled_for: evaluatedAt,
    evaluated_at: evaluatedAt,
    gate,
  }
}

export function evaluateProactiveAttentionExecution({
  candidate,
  scheduledFor,
  now = new Date().toISOString(),
  conversationMovedOn = false,
  userCurrentlyActive = false,
  quietHours = false,
  cooldownActive = false,
  dailyLimitReached = false,
  inactivityEligible = false,
} = {}) {
  const evaluatedAt = new Date(now).toISOString()
  const gate = evaluateProactiveAttention(candidate, {
    now: evaluatedAt,
    conversationMovedOn,
  })

  let arbitration = "neither"
  let executionReason = gate.reason
  let wouldSend = false
  if (gate.eligible_for_proactive_attention) {
    if (quietHours) executionReason = "quiet_hours"
    else if (cooldownActive) executionReason = "proactive_cooldown"
    else if (dailyLimitReached) executionReason = "daily_proactive_limit"
    else if (userCurrentlyActive) executionReason = "user_currently_active"
    else {
      arbitration = "proactive_event_wins"
      executionReason = "eligible_shadow_execution"
      wouldSend = true
    }
  } else if (inactivityEligible && !quietHours && !cooldownActive && !dailyLimitReached && !userCurrentlyActive) {
    arbitration = "inactivity_wins"
  }

  return {
    event_id: candidate?.event_id || null,
    scheduled_for: scheduledFor || null,
    evaluated_at: evaluatedAt,
    candidate_state: candidate?.state || null,
    attention_status: candidate?.attention_status || null,
    candidate_updated_at: candidate?.updated_at || null,
    gate_eligible: gate.eligible_for_proactive_attention,
    gate_reason: gate.reason,
    hard_rejection: gate.hard_rejection,
    rejection_type: gate.rejection_type,
    execution_reason: executionReason,
    arbitration,
    inactivity_eligible: Boolean(inactivityEligible),
    would_send: wouldSend,
    execution_mode: "shadow",
  }
}

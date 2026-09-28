export const INACTIVITY_MAX_SILENCE_MS = 12 * 60 * 60 * 1000
export const INACTIVITY_CEILING_LEAD_MS = 20 * 60 * 1000
export const INACTIVITY_RECONSIDERATION_DELAY_MS = 3 * 60 * 60 * 1000
export const INACTIVITY_CEILING_RETRY_MS = 5 * 60 * 1000

function validTime(value) {
  const time = value ? new Date(value).getTime() : NaN
  return Number.isFinite(time) ? time : null
}

export function getInactivitySilenceAnchorId(task) {
  return String(
    task?.payload?.silence_anchor_message_id
    || task?.payload?.user_message_id
    || task?.source_id
    || ""
  )
}

export function getInactivitySilenceAnchorAt(task) {
  return task?.payload?.silence_anchor_at
    || task?.payload?.scheduled_at
    || task?.created_at
    || task?.due_at
    || null
}

export function getInactivityCeilingAt(anchorAt) {
  const anchorTime = validTime(anchorAt)
  if (anchorTime === null) return null
  return new Date(anchorTime + INACTIVITY_MAX_SILENCE_MS).toISOString()
}

export function getInactivityContactDeadline(anchorAt) {
  const ceilingTime = validTime(getInactivityCeilingAt(anchorAt))
  if (ceilingTime === null) return null
  return new Date(ceilingTime - INACTIVITY_CEILING_LEAD_MS).toISOString()
}

export function capInactivityOpportunityAtCeiling(proposedAt, anchorAt) {
  const proposedTime = validTime(proposedAt)
  const deadlineTime = validTime(getInactivityContactDeadline(anchorAt))
  if (proposedTime === null) return deadlineTime === null ? null : new Date(deadlineTime).toISOString()
  if (deadlineTime === null) return new Date(proposedTime).toISOString()
  return new Date(Math.min(proposedTime, deadlineTime)).toISOString()
}

export function getInactivitySilenceState(task, now = new Date()) {
  const nowTime = validTime(now)
  const anchorAt = getInactivitySilenceAnchorAt(task)
  const anchorTime = validTime(anchorAt)
  const ceilingAt = getInactivityCeilingAt(anchorAt)
  const deadlineAt = getInactivityContactDeadline(anchorAt)
  const deadlineTime = validTime(deadlineAt)
  const silenceDurationMs = nowTime !== null && anchorTime !== null
    ? Math.max(0, nowTime - anchorTime)
    : 0
  return {
    anchor_message_id: getInactivitySilenceAnchorId(task) || null,
    anchor_at: anchorAt,
    ceiling_at: ceilingAt,
    contact_deadline_at: deadlineAt,
    silence_duration_ms: silenceDurationMs,
    silence_duration_minutes: Math.floor(silenceDurationMs / 60000),
    prior_decline_count: Math.max(0, Number(task?.payload?.prior_decline_count || 0)),
    reconsideration_count: Math.max(0, Number(task?.payload?.reconsideration_count || 0)),
    ceiling_contact_required: nowTime !== null && deadlineTime !== null && nowTime >= deadlineTime,
  }
}

export function planInactivityReconsideration(task, {
  now = new Date(),
} = {}) {
  const state = getInactivitySilenceState(task, now)
  const nowTime = validTime(now) ?? Date.now()
  const proposedAt = state.ceiling_contact_required
    ? new Date(nowTime + INACTIVITY_CEILING_RETRY_MS).toISOString()
    : new Date(nowTime + INACTIVITY_RECONSIDERATION_DELAY_MS).toISOString()
  const dueAt = state.ceiling_contact_required
    ? proposedAt
    : capInactivityOpportunityAtCeiling(proposedAt, state.anchor_at)
  return {
    due_at: dueAt,
    prior_decline_count: state.prior_decline_count + 1,
    reconsideration_count: state.reconsideration_count + 1,
    ceiling_contact_required: state.ceiling_contact_required,
    ceiling_at: state.ceiling_at,
  }
}

export function hasConversationAdvancedSinceInactivityAnchor(task, latestMessage) {
  if (!latestMessage) return true

  return String(latestMessage.id) !== getInactivitySilenceAnchorId(task)
}

export function hasUserRepliedToInactivityTask(task, latestUserMessage) {
  return hasConversationAdvancedSinceInactivityAnchor(task, latestUserMessage)
}

export function shouldApplyProactiveCooldown(message, task) {
  if (!message.metadata?.proactive) return false
  if (String(message.metadata?.proactiveTaskId || "") === String(task.id)) {
    return false
  }

  return true
}

export function getInactivityAttemptIndex(task) {
  return Math.max(1, Math.min(3, Number(task?.payload?.attempt_index || 1)))
}

export function getInactivityAttemptLimit(mode) {
  if (mode === "frequent") return 3
  if (mode === "normal") return 2
  if (mode === "relaxed") return 1
  return 0
}

export function getNextInactivityDelayMinutes(nextAttemptIndex, random = Math.random) {
  const range = nextAttemptIndex === 2
    ? [60, 120]
    : nextAttemptIndex === 3
      ? [120, 180]
      : null
  if (!range) return null
  return range[0] + Math.floor(random() * (range[1] - range[0] + 1))
}

export function canContinueInactivityChain(task, mode) {
  return getInactivityAttemptIndex(task) < getInactivityAttemptLimit(mode)
}

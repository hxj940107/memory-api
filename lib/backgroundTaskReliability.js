const RETRY_MARKER = /\s*\[background_retry:(\d+)\]\s*$/

export const BACKGROUND_PROCESSING_STALE_MS = 15 * 60 * 1000

export const BACKGROUND_RETRY_LIMITS = Object.freeze({
  proactive_attention_wakeup: 3,
  plan_follow_up: 3,
  inactivity_reach_out: 3,
  weather_shadow_check: 2,
  treehole_autonomous_update: 2,
  moment_candidate: 3,
  moment_xiaoc_activity: 3,
})

export function getBackgroundRetryLimit(type) {
  return BACKGROUND_RETRY_LIMITS[type] || 3
}

export function getPayloadRetryCount(payload) {
  const count = Math.max(
    Number(payload?.background_retry_count || 0),
    Number(payload?.proactive_attention_send_attempt_count || 0),
  )
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

export function getMarkedRetryCount(value) {
  const match = String(value || "").match(RETRY_MARKER)
  const count = Number(match?.[1] || 0)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

export function stripRetryMarker(value) {
  return String(value || "").replace(RETRY_MARKER, "").trim()
}

export function withRetryMarker(value, count) {
  const text = stripRetryMarker(value)
  return `${text}${text ? " " : ""}[background_retry:${Math.max(0, Number(count) || 0)}]`
}

export function planBackgroundFailure({ type, previousAttempts = 0 }) {
  const attemptCount = Math.max(0, Number(previousAttempts) || 0) + 1
  const retryLimit = getBackgroundRetryLimit(type)
  return {
    attemptCount,
    retryLimit,
    shouldRetry: attemptCount < retryLimit,
    status: attemptCount < retryLimit ? "pending" : "failed",
  }
}

export function isStaleProcessingTimestamp(updatedAt, now = new Date()) {
  const updatedMs = new Date(updatedAt || "").getTime()
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime()
  return Number.isFinite(updatedMs) && Number.isFinite(nowMs)
    ? nowMs - updatedMs >= BACKGROUND_PROCESSING_STALE_MS
    : false
}

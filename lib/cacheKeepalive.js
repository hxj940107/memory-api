export const BP1_CACHE_KEEPALIVE_TASK_TYPE = "bp1_cache_keepalive"
export const BP1_CACHE_KEEPALIVE_SOURCE_TYPE = "main_chat_message"
export const BP1_CACHE_KEEPALIVE_DELAY_MINUTES = 47
export const BP1_CACHE_KEEPALIVE_MIN_AGE_MINUTES = 45
export const BP1_CACHE_KEEPALIVE_MAX_AGE_MINUTES = 50

export function getBp1CacheKeepaliveDueAt(activityAt = new Date()) {
  const timestamp = new Date(activityAt).getTime()
  if (!Number.isFinite(timestamp)) throw new Error("invalid cache keepalive activity timestamp")
  return new Date(timestamp + BP1_CACHE_KEEPALIVE_DELAY_MINUTES * 60 * 1000).toISOString()
}

export function isCurrentKeepaliveActivity(task, latestUserMessage) {
  return Boolean(
    task?.source_id
    && latestUserMessage?.id
    && String(task.source_id) === String(latestUserMessage.id)
    && String(task.conversation_id || "") === String(latestUserMessage.conversation_id || "")
  )
}

export function evaluateBp1CacheKeepaliveActivity(task, latestUserMessage, now = new Date()) {
  if (!isCurrentKeepaliveActivity(task, latestUserMessage)) {
    return { eligible: false, reason: "superseded_by_new_main_chat_activity" }
  }
  const activityAt = new Date(task?.payload?.activity_at || latestUserMessage?.created_at || "").getTime()
  const nowAt = now instanceof Date ? now.getTime() : new Date(now).getTime()
  if (!Number.isFinite(activityAt) || !Number.isFinite(nowAt)) {
    return { eligible: false, reason: "invalid_main_chat_activity_time" }
  }
  const ageMinutes = (nowAt - activityAt) / 60_000
  if (ageMinutes < BP1_CACHE_KEEPALIVE_MIN_AGE_MINUTES) {
    return { eligible: false, reason: "main_chat_activity_too_recent" }
  }
  if (ageMinutes > BP1_CACHE_KEEPALIVE_MAX_AGE_MINUTES) {
    return { eligible: false, reason: "main_chat_activity_no_longer_active" }
  }
  return { eligible: true, reason: "active_cache_refresh_window", ageMinutes }
}

export function buildBp1CacheKeepaliveSuffix() {
  return {
    role: "user",
    content: "<xiaoc_cache_keepalive />",
  }
}

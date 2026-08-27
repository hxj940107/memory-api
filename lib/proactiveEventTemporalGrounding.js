export const PROACTIVE_EVENT_TIMEZONE = "Asia/Shanghai"

function isoOrNull(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function formatShanghaiDateTime(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PROACTIVE_EVENT_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const get = type => parts.find(part => part.type === type)?.value || ""
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`
}

function localBoundaryToUtc(value) {
  if (!value) return null
  const text = String(value).trim()
  const wall = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\+08:00)?$/)
  if (!wall) return null
  return isoOrNull(`${wall[1]}T${wall[2]}:${wall[3] || "00"}+08:00`)
}

export function normalizeProactiveEventWindow(proposal, {
  serverNow = new Date().toISOString(),
  userMessageCreatedAt = null,
} = {}) {
  const normalizedUserMessageTime = isoOrNull(userMessageCreatedAt)
  const local = proposal?.local_interpreted_window || { start: null, end: null }
  const start = normalizedUserMessageTime ? localBoundaryToUtc(local.start) : null
  const end = normalizedUserMessageTime ? localBoundaryToUtc(local.end) : null
  const validOrder = !(start && end && new Date(start) > new Date(end))
  return {
    proposal: {
      ...proposal,
      expected_window: validOrder ? { start, end } : { start: null, end: null },
      time_grounding: {
        source: proposal?.time_grounding_source || "insufficient_time_evidence",
        timezone: PROACTIVE_EVENT_TIMEZONE,
        server_time_utc: isoOrNull(serverNow),
        user_message_created_at_utc: normalizedUserMessageTime,
        user_message_local_time: formatShanghaiDateTime(userMessageCreatedAt),
        local_interpreted_window: {
          start: local.start || null,
          end: local.end || null,
        },
        utc_normalized_window: validOrder ? { start, end } : { start: null, end: null },
        missing_user_message_time: !normalizedUserMessageTime,
      },
    },
    errorCode: !normalizedUserMessageTime
      ? "missing_user_message_time"
      : validOrder ? null : "event_proposal_invalid_window_order",
  }
}

export function buildProactiveJudgeTimeAuthority({
  serverNow = new Date().toISOString(),
  userMessageCreatedAt = null,
} = {}) {
  return {
    current_server_time_utc: isoOrNull(serverNow),
    current_shanghai_time: formatShanghaiDateTime(serverNow),
    timezone: PROACTIVE_EVENT_TIMEZONE,
    current_user_message_created_at_utc: isoOrNull(userMessageCreatedAt),
    current_user_message_shanghai_time: formatShanghaiDateTime(userMessageCreatedAt),
  }
}

export const PROACTIVE_EVENT_TIMEZONE = "Asia/Shanghai"

const CHINESE_WEEKDAY_TO_ISO = Object.freeze({
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
})

const CHINESE_WEEKDAY_PATTERN = /(?:(下下周|下周|这周|本周)(?:星期|礼拜)?([一二三四五六日天])|(?:周|星期|礼拜)([一二三四五六日天]))/g

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

function parseShanghaiWallDateTime(value) {
  const text = String(value || "").trim()
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/)
  if (!match) return null
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
  }
}

function calendarDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day))
}

function isoWeekday(date) {
  return ((date.getUTCDay() + 6) % 7) + 1
}

function addCalendarDays(date, days) {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

function formatCalendarDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-")
}

function findSingleChineseWeekdayExpression(text) {
  const matches = [...String(text || "").matchAll(CHINESE_WEEKDAY_PATTERN)]
  if (matches.length !== 1) return null
  const [, modifier = "", modifiedWeekday, bareWeekday] = matches[0]
  const weekdayCharacter = modifiedWeekday || bareWeekday
  return {
    expression: matches[0][0],
    modifier,
    isoWeekday: CHINESE_WEEKDAY_TO_ISO[weekdayCharacter],
  }
}

export function resolveChineseWeekdayDate({
  text,
  userMessageCreatedAt,
  targetLocalTime = null,
} = {}) {
  const expression = findSingleChineseWeekdayExpression(text)
  const anchorWall = parseShanghaiWallDateTime(formatShanghaiDateTime(userMessageCreatedAt))
  if (!expression || !anchorWall) return null

  const anchorDate = calendarDate(anchorWall.year, anchorWall.month, anchorWall.day)
  const currentIsoWeekday = isoWeekday(anchorDate)
  let dayOffset

  if (expression.modifier === "下周" || expression.modifier === "下下周") {
    const weeksAhead = expression.modifier === "下下周" ? 2 : 1
    const mondayOffset = 1 - currentIsoWeekday + (7 * weeksAhead)
    dayOffset = mondayOffset + expression.isoWeekday - 1
  } else if (expression.modifier === "这周" || expression.modifier === "本周") {
    dayOffset = expression.isoWeekday - currentIsoWeekday
  } else {
    dayOffset = (expression.isoWeekday - currentIsoWeekday + 7) % 7
    if (dayOffset === 0 && targetLocalTime) {
      const targetSeconds = targetLocalTime.hour * 3600
        + targetLocalTime.minute * 60
        + targetLocalTime.second
      const anchorSeconds = anchorWall.hour * 3600
        + anchorWall.minute * 60
        + anchorWall.second
      if (targetSeconds < anchorSeconds) dayOffset = 7
    }
  }

  return {
    expression: expression.expression,
    modifier: expression.modifier || "nearest_future",
    convention: "ISO_8601_MONDAY_1_SUNDAY_7",
    anchor_local_date: formatCalendarDate(anchorDate),
    anchor_iso_weekday: currentIsoWeekday,
    target_iso_weekday: expression.isoWeekday,
    resolved_local_date: formatCalendarDate(addCalendarDays(anchorDate, dayOffset)),
  }
}

function correctBoundaryWeekday(value, resolvedDate) {
  if (!value || !resolvedDate) return value || null
  const wall = parseShanghaiWallDateTime(String(value).replace(" ", "T"))
  if (!wall) return value
  const time = [wall.hour, wall.minute, wall.second]
    .map(part => String(part).padStart(2, "0"))
    .join(":")
  return `${resolvedDate}T${time}`
}

function correctLocalWindowWeekday(local, weekdayGrounding) {
  if (!weekdayGrounding) {
    return { start: local.start || null, end: local.end || null }
  }
  const startWall = parseShanghaiWallDateTime(String(local.start || "").replace(" ", "T"))
  const endWall = parseShanghaiWallDateTime(String(local.end || "").replace(" ", "T"))
  let endDate = weekdayGrounding.resolved_local_date
  if (startWall && endWall) {
    const originalStart = calendarDate(startWall.year, startWall.month, startWall.day)
    const originalEnd = calendarDate(endWall.year, endWall.month, endWall.day)
    const spanDays = Math.round((originalEnd - originalStart) / 86400000)
    const resolvedStart = parseShanghaiWallDateTime(
      `${weekdayGrounding.resolved_local_date}T00:00:00`
    )
    endDate = formatCalendarDate(addCalendarDays(
      calendarDate(resolvedStart.year, resolvedStart.month, resolvedStart.day),
      spanDays
    ))
  }
  return {
    start: correctBoundaryWeekday(local.start, weekdayGrounding.resolved_local_date),
    end: correctBoundaryWeekday(local.end, endDate),
  }
}

export function normalizeProactiveEventWindow(proposal, {
  serverNow = new Date().toISOString(),
  userMessageCreatedAt = null,
  userMessage = "",
} = {}) {
  const normalizedUserMessageTime = isoOrNull(userMessageCreatedAt)
  const local = proposal?.local_interpreted_window || { start: null, end: null }
  const startWall = parseShanghaiWallDateTime(String(local.start || "").replace(" ", "T"))
  const weekdayGrounding = resolveChineseWeekdayDate({
    text: userMessage,
    userMessageCreatedAt,
    targetLocalTime: startWall,
  })
  const correctedLocal = correctLocalWindowWeekday(local, weekdayGrounding)
  const start = normalizedUserMessageTime ? localBoundaryToUtc(correctedLocal.start) : null
  const end = normalizedUserMessageTime ? localBoundaryToUtc(correctedLocal.end) : null
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
        local_interpreted_window: correctedLocal,
        utc_normalized_window: validOrder ? { start, end } : { start: null, end: null },
        missing_user_message_time: !normalizedUserMessageTime,
        weekday_grounding: weekdayGrounding
          ? {
              ...weekdayGrounding,
              corrected: correctedLocal.start !== (local.start || null)
                || correctedLocal.end !== (local.end || null),
            }
          : null,
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

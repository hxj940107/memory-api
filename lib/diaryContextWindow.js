function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const value = type => Number(parts.find(part => part.type === type)?.value)

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  }
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getZonedParts(date, timeZone)
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )

  return representedAsUtc - Math.floor(date.getTime() / 1000) * 1000
}

function zonedDateTimeToUtc(parts, timeZone) {
  const wallClockUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute || 0,
    parts.second || 0,
  )
  let result = new Date(wallClockUtc - getTimeZoneOffsetMs(new Date(wallClockUtc), timeZone))
  const correctedOffset = getTimeZoneOffsetMs(result, timeZone)
  result = new Date(wallClockUtc - correctedOffset)
  return result
}

export function getDiaryContextWindow(triggerAt, timeZone = "Asia/Shanghai") {
  const end = new Date(triggerAt)
  if (Number.isNaN(end.getTime())) throw new Error("Invalid Diary trigger time")

  const local = getZonedParts(end, timeZone)
  const dateAtUtcMidnight = new Date(Date.UTC(local.year, local.month - 1, local.day))
  if (local.hour < 7) dateAtUtcMidnight.setUTCDate(dateAtUtcMidnight.getUTCDate() - 1)

  const start = zonedDateTimeToUtc({
    year: dateAtUtcMidnight.getUTCFullYear(),
    month: dateAtUtcMidnight.getUTCMonth() + 1,
    day: dateAtUtcMidnight.getUTCDate(),
    hour: 7,
  }, timeZone)

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    timeZone,
  }
}

function formatCalendarDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-")
}

function parseCalendarDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return formatCalendarDate(date) === value ? date : null
}

export function getDiaryDateKey(at, timeZone = "Asia/Shanghai") {
  const instant = new Date(at)
  if (Number.isNaN(instant.getTime())) throw new Error("Invalid Diary time")

  const local = getZonedParts(instant, timeZone)
  const calendarDate = new Date(Date.UTC(local.year, local.month - 1, local.day))
  if (local.hour < 7) calendarDate.setUTCDate(calendarDate.getUTCDate() - 1)
  return formatCalendarDate(calendarDate)
}

export function getRecentDiaryDateKeys(now, count = 7, timeZone = "Asia/Shanghai") {
  const latest = parseCalendarDate(getDiaryDateKey(now, timeZone))
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(latest)
    date.setUTCDate(date.getUTCDate() - index)
    return formatCalendarDate(date)
  })
}

export function getDiaryDateContextWindow(targetDate, now, timeZone = "Asia/Shanghai") {
  const target = parseCalendarDate(targetDate)
  if (!target) throw new Error("Invalid Diary target date")

  const allowedDates = getRecentDiaryDateKeys(now, 7, timeZone)
  if (!allowedDates.includes(targetDate)) {
    throw new Error("Diary target date must be within the latest 7 diary days")
  }

  const start = zonedDateTimeToUtc({
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate(),
    hour: 7,
  }, timeZone)
  const nextDate = new Date(target)
  nextDate.setUTCDate(nextDate.getUTCDate() + 1)
  const nextBoundary = zonedDateTimeToUtc({
    year: nextDate.getUTCFullYear(),
    month: nextDate.getUTCMonth() + 1,
    day: nextDate.getUTCDate(),
    hour: 7,
  }, timeZone)
  const current = new Date(now)
  const isCurrentDiaryDay = allowedDates[0] === targetDate

  return {
    start: start.toISOString(),
    endExclusive: (isCurrentDiaryDay && current < nextBoundary ? current : nextBoundary).toISOString(),
    timeZone,
    targetDate,
    isCurrentDiaryDay,
  }
}

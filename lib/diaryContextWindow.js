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

const SHANGHAI_OFFSET = "+08:00"

export const WEATHER_SHADOW_TASK_TYPE = "weather_shadow_check"
export const WEATHER_SHADOW_SOURCE_TYPE = "weather_window"

function localDateParts(value, timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value))
  return Object.fromEntries(parts.map(part => [part.type, part.value]))
}

function addLocalDays(date, days) {
  const [year, month, day] = date.split("-").map(Number)
  const base = new Date(Date.UTC(year, month - 1, day))
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

function stableMinute(date, window) {
  const [startHour, startMinute] = window.start.split(":").map(Number)
  const [endHour, endMinute] = window.end.split(":").map(Number)
  const start = startHour * 60 + startMinute
  const end = endHour * 60 + endMinute
  const seed = [...`${date}:${window.id}`].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  return start + (seed % Math.max(1, end - start + 1))
}

function localIso(date, minuteOfDay) {
  const hours = String(Math.floor(minuteOfDay / 60)).padStart(2, "0")
  const minutes = String(minuteOfDay % 60).padStart(2, "0")
  return new Date(`${date}T${hours}:${minutes}:00${SHANGHAI_OFFSET}`).toISOString()
}

export function planWeatherShadowChecks(policy, now = new Date()) {
  const local = localDateParts(now, policy.timezone)
  const today = `${local.year}-${local.month}-${local.day}`
  const nowMs = new Date(now).getTime()
  const plans = []

  for (const dayOffset of [0, 1]) {
    const date = addLocalDays(today, dayOffset)
    for (const window of policy.windows) {
      const dueAt = localIso(date, stableMinute(date, window))
      if (new Date(dueAt).getTime() < nowMs) continue
      plans.push({
        sourceId: `${policy.location.city}:${date}:${window.id}`,
        dueAt,
        date,
        window,
      })
    }
  }
  return plans
}

export function normalizeChinaDayType(data, localDate) {
  const type = Number(data?.type?.type)
  const labels = {
    0: "workday",
    1: "weekend",
    2: "public_holiday",
    3: "adjusted_workday",
  }
  if (labels[type]) {
    return { dayType: labels[type], source: "china_holiday_calendar", reliable: true }
  }

  const weekday = new Date(`${localDate}T12:00:00${SHANGHAI_OFFSET}`).getUTCDay()
  return {
    dayType: weekday === 0 || weekday === 6 ? "weekend" : "unknown_workday",
    source: "weekday_fallback",
    reliable: false,
  }
}

function hourlyRows(forecast) {
  const hourly = forecast?.hourly || {}
  return (hourly.time || []).map((time, index) => ({
    time,
    precipitationProbability: Number(hourly.precipitation_probability?.[index]),
    apparentTemperature: Number(hourly.apparent_temperature?.[index]),
    windGust: Number(hourly.wind_gusts_10m?.[index]),
    weatherCode: Number(hourly.weather_code?.[index]),
  }))
}

function inLocalRange(time, date, start, end) {
  return time >= `${date}T${start}` && time <= `${date}T${end}`
}

const SEVERE_WEATHER_CODES = new Set([65, 67, 75, 77, 82, 86, 95, 96, 99])

export function evaluateWeatherSignal(forecast, { date, window }) {
  const rows = hourlyRows(forecast).filter(row =>
    inLocalRange(row.time, date, window.focusStart, window.focusEnd)
  )
  if (!rows.length) return { significant: false, reasons: ["forecast_window_missing"], window: null }

  const rainProbability = Math.max(...rows.map(row => Number.isFinite(row.precipitationProbability) ? row.precipitationProbability : 0))
  const minFeelsLike = Math.min(...rows.map(row => Number.isFinite(row.apparentTemperature) ? row.apparentTemperature : Infinity))
  const maxWindGust = Math.max(...rows.map(row => Number.isFinite(row.windGust) ? row.windGust : 0))
  const severe = rows.some(row => SEVERE_WEATHER_CODES.has(row.weatherCode))
  const reasons = []
  if (rainProbability >= 50) reasons.push("likely_precipitation")
  if (minFeelsLike <= 10) reasons.push("notably_cool")
  if (maxWindGust >= 50) reasons.push("strong_wind")
  if (severe) reasons.push("severe_weather")

  return {
    significant: reasons.length > 0,
    reasons,
    window: {
      local_start: `${date}T${window.focusStart}:00+08:00`,
      local_end: `${date}T${window.focusEnd}:00+08:00`,
      rain_probability_max: rainProbability,
      apparent_temperature_min: Number.isFinite(minFeelsLike) ? minFeelsLike : null,
      wind_gust_max: maxWindGust,
      severe_weather: severe,
    },
  }
}

export function parseWeatherRhythmDecision(raw) {
  try {
    const source = String(raw || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim()
    const data = JSON.parse(source)
    const rhythm = new Set(["likely_commute", "likely_rest", "explicit_outing", "unknown"])
    if (!rhythm.has(data.today_rhythm)) throw new Error("invalid today_rhythm")
    return {
      parsed: true,
      todayRhythm: data.today_rhythm,
      explicitRest: data.explicit_rest === true,
      explicitOuting: data.explicit_outing === true,
      candidateUseful: data.weather_candidate_useful === true,
      reason: String(data.reason || "").trim().slice(0, 120),
    }
  } catch (error) {
    return {
      parsed: false,
      todayRhythm: "unknown",
      explicitRest: false,
      explicitOuting: false,
      candidateUseful: false,
      reason: "invalid_structured_output",
    }
  }
}

export function decideWeatherShadowEligibility({ signal, calendar, rhythm }) {
  if (!signal?.significant) return { eligible: false, reason: "no_significant_weather" }
  if (!rhythm?.parsed) return { eligible: false, reason: "rhythm_judge_invalid" }
  if (rhythm.explicitRest && !rhythm.explicitOuting && !signal.reasons.includes("severe_weather")) {
    return { eligible: false, reason: "explicit_rest_without_outing" }
  }
  if (["weekend", "public_holiday"].includes(calendar?.dayType) && !rhythm.explicitOuting && !signal.reasons.includes("severe_weather")) {
    return { eligible: false, reason: "non_workday_without_outing" }
  }
  if (!calendar?.reliable && calendar?.dayType === "unknown_workday" && rhythm.todayRhythm === "unknown") {
    return { eligible: false, reason: "workday_status_uncertain" }
  }
  if (!rhythm.candidateUseful) return { eligible: false, reason: rhythm.reason || "model_declined" }
  return { eligible: true, reason: rhythm.reason || "weather_context_relevant" }
}

import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import { WEATHER_SHADOW_POLICY } from "../lib/aiConfig.js"
import {
  decideWeatherShadowEligibility,
  evaluateWeatherSignal,
  normalizeChinaDayType,
  parseWeatherRhythmDecision,
  planWeatherShadowChecks,
} from "../lib/weatherShadow.js"

function forecast(rows) {
  return {
    hourly: {
      time: rows.map(row => row.time),
      precipitation_probability: rows.map(row => row.rain),
      apparent_temperature: rows.map(row => row.feels),
      wind_gusts_10m: rows.map(row => row.wind),
      weather_code: rows.map(row => row.code),
    },
  }
}

test("weather checks use bounded Nanjing rhythm windows rather than fixed instants", () => {
  const plans = planWeatherShadowChecks(
    WEATHER_SHADOW_POLICY,
    new Date("2026-09-03T00:00:00.000Z"),
  )
  assert.ok(plans.length >= 2)
  assert.ok(plans.every(plan => plan.sourceId.startsWith("南京:")))
  for (const plan of plans) {
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(plan.dueAt))
    assert.ok(local >= plan.window.start && local <= plan.window.end)
  }
})

test("weather signal only promotes materially useful forecast facts", () => {
  const quiet = evaluateWeatherSignal(forecast([
    { time: "2026-09-03T07:30", rain: 10, feels: 22, wind: 15, code: 1 },
  ]), { date: "2026-09-03", window: WEATHER_SHADOW_POLICY.windows[0] })
  assert.equal(quiet.significant, false)

  const rain = evaluateWeatherSignal(forecast([
    { time: "2026-09-03T07:30", rain: 70, feels: 19, wind: 18, code: 61 },
  ]), { date: "2026-09-03", window: WEATHER_SHADOW_POLICY.windows[0] })
  assert.equal(rain.significant, true)
  assert.ok(rain.reasons.includes("likely_precipitation"))
})

test("calendar distinguishes public rest days and adjusted workdays", () => {
  assert.equal(normalizeChinaDayType({ type: { type: 2 } }, "2026-10-01").dayType, "public_holiday")
  assert.equal(normalizeChinaDayType({ type: { type: 3 } }, "2026-10-10").dayType, "adjusted_workday")
  assert.equal(normalizeChinaDayType(null, "2026-09-05").dayType, "weekend")
})

test("rest days suppress commute weather unless there is an outing or severe weather", () => {
  const signal = { significant: true, reasons: ["likely_precipitation"] }
  const rest = parseWeatherRhythmDecision(JSON.stringify({
    today_rhythm: "likely_rest",
    explicit_rest: true,
    explicit_outing: false,
    weather_candidate_useful: true,
    reason: "她明确说今天休息",
  }))
  assert.deepEqual(
    decideWeatherShadowEligibility({
      signal,
      calendar: { dayType: "workday", reliable: true },
      rhythm: rest,
    }),
    { eligible: false, reason: "explicit_rest_without_outing" },
  )

  const outing = { ...rest, explicitOuting: true, todayRhythm: "explicit_outing" }
  assert.equal(decideWeatherShadowEligibility({
    signal,
    calendar: { dayType: "public_holiday", reliable: true },
    rhythm: outing,
  }).eligible, true)
})

test("weather phase remains strict Shadow and does not enter message send paths", () => {
  const source = fs.readFileSync("api/memory.js", "utf8")
  assert.match(source, /WEATHER_SHADOW_TASK_TYPE/)
  assert.match(source, /shadowOnly: true/)
  assert.match(source, /message_generation_called: false/)
  assert.match(source, /actual_send_attempted: false/)
  assert.doesNotMatch(source, /saveProactiveMessage\(\{[^}]*weather_shadow/s)
})

test("weather and timezone locations remain separate configuration facts", () => {
  assert.equal(WEATHER_SHADOW_POLICY.timezone, "Asia/Shanghai")
  assert.equal(WEATHER_SHADOW_POLICY.location.city, "南京")
  assert.equal(WEATHER_SHADOW_POLICY.location.source, "user_explicit")
})

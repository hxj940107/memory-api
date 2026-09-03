import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import { WEATHER_SHADOW_POLICY, isWeatherLiveSendEnabled } from "../lib/aiConfig.js"
import {
  decideWeatherShadowEligibility,
  evaluateWeatherLiveBoundary,
  evaluateWeatherSignal,
  getWeatherSignalSignature,
  normalizeChinaDayType,
  parseWeatherMessageDecision,
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

test("weather live send is fail-closed and disabled runs remain Shadow", () => {
  const source = fs.readFileSync("api/memory.js", "utf8")
  assert.equal(isWeatherLiveSendEnabled({}), false)
  assert.equal(isWeatherLiveSendEnabled({ WEATHER_LIVE_SEND_ENABLED: "false" }), false)
  assert.equal(isWeatherLiveSendEnabled({ WEATHER_LIVE_SEND_ENABLED: "true" }), true)
  assert.match(source, /WEATHER_SHADOW_TASK_TYPE/)
  assert.match(source, /shadowOnly: true/)
  assert.match(source, /isWeatherLiveSendEnabled/)
  assert.match(source, /weather_limited_send_generation/)
})

test("weather live boundary preserves proactive policy and duplicate suppression", () => {
  const eligible = {
    shadowEligible: true,
    sendEnabled: true,
    quietHours: false,
    cooldownActive: false,
    dailyLimitReached: false,
    userCurrentlyActive: false,
    alreadySent: false,
  }
  assert.deepEqual(evaluateWeatherLiveBoundary(eligible), {
    allowed: true,
    reason: "limited_send_eligible",
  })
  assert.equal(evaluateWeatherLiveBoundary({ ...eligible, cooldownActive: true }).reason, "proactive_cooldown")
  assert.equal(evaluateWeatherLiveBoundary({ ...eligible, userCurrentlyActive: true }).reason, "user_currently_active")
  assert.equal(evaluateWeatherLiveBoundary({ ...eligible, alreadySent: true }).reason, "weather_signal_already_sent")
})

test("weather generation may naturally decline and has no fallback copy", () => {
  assert.deepEqual(parseWeatherMessageDecision(JSON.stringify({
    should_send: false,
    contact_motivation: "现在不适合打扰她",
    message: "",
  })), {
    parsed: true,
    shouldSend: false,
    motivation: "现在不适合打扰她",
    message: "",
  })
  assert.equal(parseWeatherMessageDecision("broken").parsed, false)
})

test("same weather process has a stable daily signature", () => {
  const signal = { reasons: ["strong_wind", "likely_precipitation"] }
  assert.equal(
    getWeatherSignalSignature({ date: "2026-09-03", signal }),
    "2026-09-03:likely_precipitation+strong_wind",
  )
})

test("weather wins before inactivity only when it passes live boundaries", () => {
  const source = fs.readFileSync("api/memory.js", "utf8")
  assert.match(source, /weather_shadow_check: 2,\s+inactivity_reach_out: 3/)
  assert.match(source, /本轮由天气主动联系完成联系，避免同一时段重复发送/)
  assert.match(source, /finalSignal\.significant && finalSignature === signalSignature/)
  assert.match(source, /user_returned_during_generation/)
  assert.match(source, /metadata\?\.proactiveTaskId[^]*task\.id/)
})

test("weather and timezone locations remain separate configuration facts", () => {
  assert.equal(WEATHER_SHADOW_POLICY.timezone, "Asia/Shanghai")
  assert.equal(WEATHER_SHADOW_POLICY.location.city, "南京")
  assert.equal(WEATHER_SHADOW_POLICY.location.source, "user_explicit")
})

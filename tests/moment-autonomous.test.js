import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  AUTONOMOUS_MOMENT_POLICY,
  buildAutonomousMomentPrompt,
  getNextAutonomousMomentTime,
  normalizeAutonomousMomentTimestamp,
} from "../lib/momentAutonomous.js"

test("Supabase ISO timestamps are normalized before Intl formatting and invalid rows fail safe", () => {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai" })
  const normalized = normalizeAutonomousMomentTimestamp("2026-09-21T12:25:00.255+00:00")

  assert.ok(normalized instanceof Date)
  assert.doesNotThrow(() => formatter.formatToParts(normalized))
  assert.equal(normalizeAutonomousMomentTimestamp("not-a-timestamp"), null)
})

test("autonomous cadence is low-frequency and gives longer silence more opportunities", () => {
  const now = new Date("2026-09-20T08:00:00.000Z")
  const initial = getNextAutonomousMomentTime({ now, initial: true, random: () => 0 })
  const normal = getNextAutonomousMomentTime({ now, lastPublishedAt: "2026-09-19T08:00:00Z", random: () => 0 })
  const silent = getNextAutonomousMomentTime({ now, lastPublishedAt: "2026-09-01T08:00:00Z", random: () => 0 })
  const repeatedDeclines = getNextAutonomousMomentTime({
    now,
    consecutiveDeclines: AUTONOMOUS_MOMENT_POLICY.extendedDeclineCount,
    random: () => 0,
  })

  assert.equal((new Date(initial) - now) / 3_600_000, AUTONOMOUS_MOMENT_POLICY.initialMinHours)
  assert.equal((new Date(normal) - now) / 3_600_000, AUTONOMOUS_MOMENT_POLICY.normalMinHours)
  assert.equal((new Date(silent) - now) / 3_600_000, AUTONOMOUS_MOMENT_POLICY.extendedSilenceMinHours)
  assert.equal((new Date(repeatedDeclines) - now) / 3_600_000, AUTONOMOUS_MOMENT_POLICY.extendedSilenceMinHours)
})

test("autonomous consideration allows decline, thoughts and authorized album material without caption examples", () => {
  const prompt = buildAutonomousMomentPrompt({
    environment: "synthetic environment",
    recentMoments: "暂无",
    materials: "[a1] type=album_image permission=xiaoc_independent",
  })
  const text = prompt.map(item => item.content).join("\n")

  assert.match(text, /shouldPost=false 永远合法/)
  assert.match(text, /纯文字自主想法使用 thought/)
  assert.match(text, /permission=xiaoc_independent/)
  assert.match(text, /用户个人照片是合法素材/)
  assert.doesNotMatch(text, /例如|合适文案|参考文案|示例文案/)
})

test("worker wiring keeps ordinary ticks and publishing deterministic", () => {
  const source = fs.readFileSync("api/memory.js", "utf8")
  const autonomousStart = source.indexOf("async function checkAutonomousMomentConsideration")
  const publishStart = source.indexOf("async function checkPendingMomentCandidates")
  const publishEnd = source.indexOf("async function checkPendingMomentsForXiaoC")
  const autonomous = source.slice(autonomousStart, publishStart)
  const publish = source.slice(publishStart, publishEnd)
  const handlerStart = source.indexOf('type === "xiaoc_background_check"')
  const handler = source.slice(handlerStart, handlerStart + 1800)

  assert.equal((autonomous.match(/callSmallLLM\(/g) || []).length, 1)
  assert.equal((publish.match(/callSmallLLM\(/g) || []).length, 0)
  assert.match(autonomous, /reason: "not_due"/)
  assert.match(autonomous, /model_calls: 0/)
  assert.match(source, /normalizeAutonomousMomentTimestamp\(item\.created_at\)/)
  assert.match(source, /if \(!occurredAt\) return \[\]/)
  assert.match(handler, /checkAutonomousMomentConsideration\(\)/)
  assert.match(autonomous, /markAutonomousMomentError\(error, "model_call"\)/)
  assert.match(autonomous, /markAutonomousMomentError\(error, "parse"\)/)
  assert.match(autonomous, /markAutonomousMomentError\(error, "candidate_insert"\)/)
  assert.match(autonomous, /markAutonomousMomentError\(stateError, "state_load"\)/)
  assert.match(autonomous, /markAutonomousMomentError\(result\.error, "context_load"\)/)
  assert.match(autonomous, /markAutonomousMomentError\(error, "material_prepare"\)/)
  assert.match(source, /markAutonomousMomentError\(error, "state_update"\)/)
  assert.match(handler, /AUTONOMOUS MOMENT FAILED:/)
  assert.doesNotMatch(handler, /workerError\.message|workerError\.stack/)
})

test("schema records autonomous schedule and candidate provenance without a new API function", () => {
  const migration = fs.readFileSync("supabase_moment_autonomous_consideration.sql", "utf8")
  const apiFiles = fs.readdirSync("api").filter(name => name.endsWith(".js"))

  assert.match(migration, /create table if not exists public\.moment_autonomous_state/)
  assert.match(migration, /consideration_mode/)
  assert.match(migration, /source_ref/)
  assert.match(migration, /narrative_permission/)
  assert.equal(apiFiles.length, 12)
})

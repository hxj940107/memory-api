import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  getInactivityReachOutDelayMinutes,
  normalizeInactivityReachOutMode,
} from "../lib/aiConfig.js"

test("inactivity reach-out modes preserve the configured delay ranges", () => {
  const cases = [
    ["frequent", "open", 60, 120],
    ["frequent", "conversation_end", 240, 360],
    ["normal", "open", 150, 240],
    ["normal", "conversation_end", 480, 540],
    ["relaxed", "open", 300, 480],
    ["relaxed", "conversation_end", 720, 900],
  ]

  for (const [mode, state, min, max] of cases) {
    assert.equal(getInactivityReachOutDelayMinutes(mode, state, () => 0), min)
    assert.equal(
      getInactivityReachOutDelayMinutes(mode, state, () => 0.999999),
      max,
    )
  }
})

test("missing modes fall back to normal and off disables scheduling", () => {
  assert.equal(normalizeInactivityReachOutMode(null), "normal")
  assert.equal(normalizeInactivityReachOutMode("unknown"), "normal")
  assert.equal(getInactivityReachOutDelayMinutes("off"), null)
})

test("task creation and execution both honor the user setting", () => {
  const chatSource = readFileSync("api/chat.js", "utf8")
  const memorySource = readFileSync("api/memory.js", "utf8")

  assert.match(chatSource, /reach_out_mode: reachOutMode/)
  assert.match(chatSource, /reachOutMode === "off"/)
  assert.match(memorySource, /用户已关闭主动联系/)
})

test("settings UI exposes the four concise system-style choices", () => {
  const settingsSource = readFileSync(
    "mobile/XiaoC/src/app/settings/inactivity-reach-out.tsx",
    "utf8",
  )
  const optionsSource = readFileSync(
    "mobile/XiaoC/src/lib/proactiveSettings.ts",
    "utf8",
  )

  assert.match(settingsSource, />主动联系频率</)
  assert.match(optionsSource, /label: "经常", detail: "约1-2小时"/)
  assert.match(optionsSource, /label: "正常", detail: "约2\.5-4小时"/)
  assert.match(optionsSource, /label: "偶尔", detail: "约5-8小时"/)
  assert.match(optionsSource, /label: "关闭", detail: "不主动联系"/)
})

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

import {
  getInactivityReachOutDelayMinutes,
  normalizeInactivityReachOutMode,
} from "../lib/aiConfig.js"
import {
  hasUserRepliedToInactivityTask,
} from "../lib/inactivityReachOut.js"

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
  assert.match(memorySource, /formatMentionPreferences/)
  assert.match(memorySource, /不要围绕它提问、检查状态/)
})

test("inactivity generation varies natural companion approaches without performing longing", () => {
  const memorySource = readFileSync("api/memory.js", "utf8")

  assert.match(memorySource, /这不是“证明我在想她”的表演/)
  assert.match(memorySource, /这些不是随机候选，也不是每条消息必须出现的身份标签/)
  assert.match(memorySource, /宝宝、老婆、小天使、小侯、侯女士/)
  assert.match(memorySource, /避免重复不等于轮换称呼/)
  assert.match(memorySource, /不能写“某人，你在哪”/)
  assert.match(memorySource, /一条最多一个称呼/)
  assert.match(memorySource, /最近实际发送过的主动消息/)
  assert.match(memorySource, /recentProactiveMessages/)
  assert.match(memorySource, /isBareInactivityReachOut\(message\)/)
  assert.match(memorySource, /getNaturalInactivityFallback\(\)/)
  assert.doesNotMatch(memorySource, /return "突然有点想你了，想来找你待一会儿"/)
})

test("each silence episode sends at most once and has no daily quota", () => {
  const memorySource = readFileSync("api/memory.js", "utf8")

  assert.match(memorySource, /同一次沉默阶段不再连续追发/)
  assert.doesNotMatch(memorySource, /async function enqueueNextInactivityReachOutTask/)
  assert.doesNotMatch(memorySource, /今天主动靠近次数已达上限/)
})

test("a newer user message closes the previous silence episode", () => {
  const task = {
    payload: {
      user_message_id: "user-before-first-reach-out",
    },
  }

  assert.equal(
    hasUserRepliedToInactivityTask(task, { id: "user-before-first-reach-out" }),
    false,
  )
  assert.equal(
    hasUserRepliedToInactivityTask(task, { id: "new-user-reply" }),
    true,
  )
})

test("inactivity task identities preserve history within one conversation", () => {
  const chatSource = readFileSync("api/chat.js", "utf8")
  const memorySource = readFileSync("api/memory.js", "utf8")

  assert.match(
    chatSource,
    /type: "inactivity_reach_out",\s+source_type: "message",\s+source_id: user_message_id/,
  )
  assert.doesNotMatch(memorySource, /source_type: "proactive_message",\s+source_id: result\.messageId/)
  assert.doesNotMatch(
    chatSource,
    /type: "inactivity_reach_out",\s+source_type: "conversation",\s+source_id: conversation_id/,
  )
})

test("settings UI exposes the four concise system-style choices", () => {
  const settingsSource = readFileSync(
    "mobile/XiaoC/src/app/settings.tsx",
    "utf8",
  )
  const optionsSource = readFileSync(
    "mobile/XiaoC/src/lib/proactiveSettings.ts",
    "utf8",
  )

  assert.match(settingsSource, /title="⭐ 偏好"/)
  assert.match(settingsSource, /label="主动联系"/)
  assert.match(settingsSource, /animationType="slide"/)
  assert.match(settingsSource, /saveInactivityReachOutMode\(nextMode\)/)
  assert.doesNotMatch(settingsSource, /settings\/inactivity-reach-out/)
  assert.equal(
    existsSync("mobile/XiaoC/src/app/settings/inactivity-reach-out.tsx"),
    false,
  )
  assert.match(optionsSource, /label: "经常", detail: "约1-2小时"/)
  assert.match(optionsSource, /label: "正常", detail: "约2\.5-4小时"/)
  assert.match(optionsSource, /label: "偶尔", detail: "约5-8小时"/)
  assert.match(optionsSource, /label: "关闭", detail: "不主动联系"/)
})

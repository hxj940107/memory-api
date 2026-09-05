import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

import {
  getInactivityReachOutDelayMinutes,
  normalizeInactivityReachOutMode,
} from "../lib/aiConfig.js"
import {
  canContinueInactivityChain,
  getInactivityAttemptIndex,
  getInactivityAttemptLimit,
  getNextInactivityDelayMinutes,
  hasUserRepliedToInactivityTask,
  shouldApplyProactiveCooldown,
} from "../lib/inactivityReachOut.js"

test("inactivity reach-out modes preserve the configured delay ranges", () => {
  const cases = [
    ["frequent", "open", 60, 120],
    ["frequent", "conversation_end", 120, 180],
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

test("frequent conversation endings protect the near term but reach Judge within three hours", () => {
  const earliestJudgeOpportunity = getInactivityReachOutDelayMinutes(
    "frequent",
    "conversation_end",
    () => 0,
  )
  const latestJudgeOpportunity = getInactivityReachOutDelayMinutes(
    "frequent",
    "conversation_end",
    () => 0.999999,
  )

  assert.equal(earliestJudgeOpportunity, 120)
  assert.equal(latestJudgeOpportunity, 180)
  assert.ok(earliestJudgeOpportunity > 60)
})

test("frequent open conversations keep their existing one-to-two-hour Judge window", () => {
  assert.equal(getInactivityReachOutDelayMinutes("frequent", "open", () => 0), 60)
  assert.equal(
    getInactivityReachOutDelayMinutes("frequent", "open", () => 0.999999),
    120,
  )
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
  assert.match(memorySource, /某人/)
  assert.match(memorySource, /联系次数增加不要求语气固定升级/)
  assert.match(memorySource, /已经自然结束或完整回应的话题不会因为经过一段时间重新变成待续内容/)
  assert.doesNotMatch(memorySource, /isBareInactivityReachOut\(message\)/)
  assert.doesNotMatch(memorySource, /getNaturalInactivityFallback\(\)/)
  assert.match(memorySource, /最近聊天是你和她刚刚共同经历的生活/)
  assert.match(memorySource, /想联系不等于必须有具体事情要问/)
  assert.match(memorySource, /技术讨论、日常生活、情绪和关系互动一视同仁/)
  assert.match(memorySource, /parseInactivityGeneration/)
  assert.match(memorySource, /validateInactivityGeneration/)
  assert.match(memorySource, /fallback_applied/)
  assert.match(memorySource, /fallback_reason/)
  assert.match(memorySource, /inactivityGeneration/)
  assert.doesNotMatch(memorySource, /return "突然有点想你了，想来找你待一会儿"/)
})

test("silence continuation has bounded mode-aware attempts and no daily quota", () => {
  const memorySource = readFileSync("api/memory.js", "utf8")

  assert.equal(getInactivityAttemptLimit("frequent"), 3)
  assert.equal(getInactivityAttemptLimit("normal"), 2)
  assert.equal(getInactivityAttemptLimit("relaxed"), 1)
  assert.equal(getInactivityAttemptLimit("off"), 0)
  assert.equal(getInactivityAttemptIndex({ payload: {} }), 1)
  assert.equal(canContinueInactivityChain({ payload: { attempt_index: 1 } }, "frequent"), true)
  assert.equal(canContinueInactivityChain({ payload: { attempt_index: 3 } }, "frequent"), false)
  assert.equal(getNextInactivityDelayMinutes(2, () => 0), 60)
  assert.equal(getNextInactivityDelayMinutes(2, () => 0.999999), 120)
  assert.equal(getNextInactivityDelayMinutes(3, () => 0), 120)
  assert.equal(getNextInactivityDelayMinutes(3, () => 0.999999), 180)
  assert.match(memorySource, /async function enqueueNextInactivityReachOutTask/)
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

test("existing cooldown and frequency gates remain effective after the first Judge opportunity", () => {
  const task = { id: "current-task" }

  assert.equal(
    shouldApplyProactiveCooldown({
      metadata: {
        proactive: true,
        proactiveTaskId: "earlier-task",
      },
    }, task),
    true,
  )
  assert.equal(canContinueInactivityChain({ payload: { attempt_index: 3 } }, "frequent"), false)
})

test("quiet hours still defer due inactivity tasks before execution", () => {
  const chatSource = readFileSync("api/chat.js", "utf8")
  const memorySource = readFileSync("api/memory.js", "utf8")

  assert.match(chatSource, /return deferOutOfQuietHours\(/)
  assert.match(memorySource, /if \(isProactiveQuietHours\(now\) && quietDeferred\.length\)/)
})

test("a continuation keeps the silence root so any later user reply cancels it", () => {
  const task = {
    source_type: "proactive_message",
    source_id: "first-proactive-message",
    payload: {
      attempt_index: 2,
      silence_root_user_message_id: "silence-root-user-message",
      user_message_id: "silence-root-user-message",
      continuation_of_task_id: "first-inactivity-task",
      previous_proactive_message_ids: ["first-proactive-message"],
    },
  }

  assert.equal(
    hasUserRepliedToInactivityTask(task, { id: "silence-root-user-message" }),
    false,
  )
  assert.equal(
    hasUserRepliedToInactivityTask(task, { id: "user-returned" }),
    true,
  )
})

test("event follow-up substitutes for one inactivity contact without double advancing on retry", () => {
  const memorySource = readFileSync("api/memory.js", "utf8")

  assert.match(memorySource, /async function consumePendingInactivityWithEventMessage/)
  assert.match(memorySource, /本轮由现实事件主动回访完成联系，避免同一时段重复发送/)
  assert.match(memorySource, /previouslyCountedMessageIds\.includes\(String\(messageId\)\)/)
  assert.match(memorySource, /await consumePendingInactivityWithEventMessage\(/)
})

test("inactivity task identities preserve history within one conversation", () => {
  const chatSource = readFileSync("api/chat.js", "utf8")
  const memorySource = readFileSync("api/memory.js", "utf8")

  assert.match(
    chatSource,
    /type: "inactivity_reach_out",\s+source_type: "message",\s+source_id: user_message_id/,
  )
  assert.match(memorySource, /source_type: "proactive_message"/)
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

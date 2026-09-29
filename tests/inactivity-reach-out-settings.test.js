import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

import {
  getInactivityReachOutDelayMinutes,
  normalizeInactivityReachOutMode,
} from "../lib/aiConfig.js"
import {
  INACTIVITY_MAX_SILENCE_MS,
  capInactivityOpportunityAtCeiling,
  getInactivityCeilingAt,
  getInactivityReconciliationSource,
  getInactivitySilenceState,
  getInactivityAttemptIndex,
  hasConversationAdvancedSinceInactivityAnchor,
  hasUserRepliedToInactivityTask,
  planInactivityLifecycleRecovery,
  planInactivityReconsideration,
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

test("model decline schedules another bounded reconsideration instead of ending lifecycle", () => {
  const memorySource = readFileSync("api/memory.js", "utf8")
  const anchorAt = "2026-09-28T00:00:00.000Z"
  const task = { payload: { silence_anchor_at: anchorAt, prior_decline_count: 0 } }
  const plan = planInactivityReconsideration(task, {
    now: new Date("2026-09-28T04:00:00.000Z"),
  })

  assert.equal(plan.prior_decline_count, 1)
  assert.equal(plan.reconsideration_count, 1)
  assert.equal(plan.ceiling_contact_required, false)
  assert.equal(plan.due_at, "2026-09-28T07:00:00.000Z")
  assert.match(memorySource, /generation\.skipped[\s\S]*planInactivityReconsideration/)
  assert.match(memorySource, /deferred: true,[\s\S]*dueAt: reconsideration\.due_at/)
})

test("continuous declines converge on the 12-hour contact deadline", () => {
  const anchorAt = "2026-09-28T00:00:00.000Z"
  const deadline = capInactivityOpportunityAtCeiling(
    "2026-09-29T00:00:00.000Z",
    anchorAt,
  )
  assert.equal(INACTIVITY_MAX_SILENCE_MS, 12 * 60 * 60 * 1000)
  assert.equal(getInactivityCeilingAt(anchorAt), "2026-09-28T12:00:00.000Z")
  assert.equal(deadline, "2026-09-28T11:40:00.000Z")

  const nearCeilingTask = {
    payload: {
      silence_anchor_at: anchorAt,
      prior_decline_count: 3,
      reconsideration_count: 3,
    },
  }
  const state = getInactivitySilenceState(
    nearCeilingTask,
    new Date("2026-09-28T11:40:00.000Z"),
  )
  assert.equal(state.ceiling_contact_required, true)
  assert.equal(state.prior_decline_count, 3)
})

test("missing lifecycle recovery preserves the original message anchor and ceiling", () => {
  const anchorAt = "2026-09-28T00:00:00.000Z"
  const sixHourRecovery = planInactivityLifecycleRecovery({
    anchorAt,
    now: new Date("2026-09-28T06:00:00.000Z"),
    delayMinutes: 180,
  })

  assert.equal(sixHourRecovery.due_at, "2026-09-28T06:00:00.000Z")
  assert.equal(sixHourRecovery.ceiling_at, "2026-09-28T12:00:00.000Z")
  assert.equal(sixHourRecovery.ceiling_contact_required, false)

  const overdueRecovery = planInactivityLifecycleRecovery({
    anchorAt,
    now: new Date("2026-09-28T16:00:00.000Z"),
    delayMinutes: 180,
  })
  assert.equal(overdueRecovery.due_at, "2026-09-28T16:00:00.000Z")
  assert.equal(overdueRecovery.ceiling_at, "2026-09-28T12:00:00.000Z")
  assert.equal(overdueRecovery.ceiling_contact_required, true)
})

test("reconciliation uses the same deterministic task identity as normal message paths", () => {
  assert.deepEqual(
    getInactivityReconciliationSource({
      id: "assistant-message",
      role: "assistant",
      metadata: { replyToUserMessageId: "user-message" },
    }),
    { source_type: "message", source_id: "user-message" },
  )
  assert.deepEqual(
    getInactivityReconciliationSource({
      id: "proactive-message",
      role: "assistant",
      metadata: { proactive: true },
    }),
    { source_type: "proactive_message", source_id: "proactive-message" },
  )
})

test("worker reconciliation restores only a missing current silence lifecycle", () => {
  const memorySource = readFileSync("api/memory.js", "utf8")

  assert.match(memorySource, /async function reconcileInactivityLifecycle/)
  assert.match(memorySource, /reason: "active_lifecycle_exists"/)
  assert.match(memorySource, /latestMessage\.conversation_id/)
  assert.match(memorySource, /silence_anchor_message_id: latestMessageId/)
  assert.match(memorySource, /silence_anchor_at: latestMessage\.created_at/)
  assert.match(memorySource, /silence_ceiling_at: recovery\.ceiling_at/)
  assert.match(memorySource, /reconciled_from_terminal_task_id/)
  assert.match(memorySource, /onConflict: "user_id,type,source_type,source_id"/)
  assert.match(memorySource, /await reconcileInactivityLifecycle\(\{/)
  assert.match(memorySource, /reason: "hard_opt_out"/)
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
})

test("quiet hours still defer due inactivity tasks before execution", () => {
  const chatSource = readFileSync("api/chat.js", "utf8")
  const memorySource = readFileSync("api/memory.js", "utf8")

  assert.match(chatSource, /deferOutOfQuietHours\(/)
  assert.match(memorySource, /if \(isProactiveQuietHours\(now\) && quietDeferred\.length\)/)
  assert.match(memorySource, /ceiling_contact_required/)
  assert.match(memorySource, /capInactivityOpportunityAtCeiling/)
})

test("a continuation keeps the silence root so any later user reply cancels it", () => {
  const task = {
    source_type: "proactive_message",
    source_id: "first-proactive-message",
    payload: {
      attempt_index: 2,
      silence_root_user_message_id: "silence-root-user-message",
      user_message_id: "silence-root-user-message",
      silence_anchor_message_id: "first-proactive-message",
      continuation_of_task_id: "first-inactivity-task",
      previous_proactive_message_ids: ["first-proactive-message"],
    },
  }

  assert.equal(
    hasConversationAdvancedSinceInactivityAnchor(task, { id: "first-proactive-message" }),
    false,
  )
  assert.equal(
    hasConversationAdvancedSinceInactivityAnchor(task, { id: "user-returned" }),
    true,
  )
})

test("a sent proactive message resets the silence clock and starts another lifecycle", () => {
  const memorySource = readFileSync("api/memory.js", "utf8")

  assert.match(memorySource, /silence_anchor_message_id: String\(messageId\)/)
  assert.match(memorySource, /silence_anchor_at: silenceAnchorAt/)
  assert.match(memorySource, /silence_ceiling_at: getInactivityCeilingAt\(silenceAnchorAt\)/)
  assert.match(memorySource, /prior_decline_count: 0/)
  assert.match(memorySource, /reconsideration_count: 0/)
})

test("new conversation activity invalidates an old task before and after generation", () => {
  const memorySource = readFileSync("api/memory.js", "utf8")
  const task = { payload: { silence_anchor_message_id: "old-anchor" } }

  assert.equal(hasConversationAdvancedSinceInactivityAnchor(task, { id: "new-message" }), true)
  assert.match(memorySource, /生成期间对话已有新的消息，旧沉默窗口失效/)
  assert.match(memorySource, /\.eq\("status", "pending"\)[\s\S]*\.select\("id"\)/)
})

test("autonomy remains before the ceiling while explicit opt-out remains hard", () => {
  const memorySource = readFileSync("api/memory.js", "utf8")

  assert.match(memorySource, /如果此刻没有自然动机，可以 should_send=false/)
  assert.match(memorySource, /当前已到必须自然重新建立联系的最终机会/)
  assert.match(memorySource, /newerMoment && !silenceState\.ceiling_contact_required/)
  assert.match(memorySource, /higherPriority && !silenceState\.ceiling_contact_required/)
  assert.match(memorySource, /cooldown && !ceilingContactRequired/)
  assert.match(memorySource, /reachOutMode === "off"/)
  assert.match(memorySource, /用户已关闭主动联系/)
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

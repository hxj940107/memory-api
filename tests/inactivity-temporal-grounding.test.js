import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import {
  formatTimedInactivityMessages,
  formatTimestampedConversationMessage,
  getInactivityEventEvidence,
  isTemporallyUnsupportedReachOut,
  validateProactiveHistoricalClaims,
} from "../lib/inactivityTemporalGrounding.js"

const message = (role, content, created_at) => ({ role, content, created_at })

test("a next-day plan mentioned the prior night is not treated as started early next morning", () => {
  const messages = [
    message("user", "明天准备处理一件新的事情", "2026-08-24T15:10:00.000Z"),
    message("user", "我先睡觉了", "2026-08-24T15:21:00.000Z"),
    message("assistant", "晚安", "2026-08-24T15:21:10.000Z"),
  ]

  assert.equal(getInactivityEventEvidence(messages).futureIntentStillUnconfirmed, true)
  assert.equal(isTemporallyUnsupportedReachOut("现在进展怎么样了", messages), true)
})

test("an explicitly ongoing event permits a progress question", () => {
  const messages = [
    message("user", "我正在处理这件事", "2026-08-25T02:00:00.000Z"),
  ]

  assert.equal(getInactivityEventEvidence(messages).hasStartedEvidence, true)
  assert.equal(isTemporallyUnsupportedReachOut("现在进展怎么样了", messages), false)
})

test("an explicitly completed event permits continuing around its result", () => {
  const messages = [
    message("user", "这件事情已经完成了", "2026-08-25T03:00:00.000Z"),
  ]

  assert.equal(getInactivityEventEvidence(messages).hasCompletedEvidence, true)
  assert.equal(isTemporallyUnsupportedReachOut("最后结果怎么样", messages), false)
})

test("bedtime and a date change do not advance a future plan", () => {
  const messages = [
    message("user", "之后准备去办一件事", "2026-08-24T15:00:00.000Z"),
    message("user", "晚安，我要睡了", "2026-08-24T15:21:00.000Z"),
  ]

  assert.equal(isTemporallyUnsupportedReachOut("事情做完了吗", messages), true)
})

test("insufficient event evidence rejects progress completion and fatigue assumptions", () => {
  const messages = [
    message("user", "今天外面天气还不错", "2026-08-25T01:00:00.000Z"),
  ]

  assert.equal(isTemporallyUnsupportedReachOut("做得怎么样了", messages), true)
  assert.equal(isTemporallyUnsupportedReachOut("累不累", messages), true)
  assert.equal(isTemporallyUnsupportedReachOut("只是有点想来找你", messages), false)
})

test("recent message timestamps are rendered in Asia Shanghai local time", () => {
  const formatted = formatTimedInactivityMessages([
    message("user", "准备休息", "2026-08-24T15:21:00.000Z"),
    message("assistant", "晚安", "2026-08-24T15:21:10.000Z"),
  ])

  assert.match(formatted, /\[2026-08-24 23:21 Asia\/Shanghai\] 她：准备休息/)
  assert.match(formatted, /\[2026-08-24 23:21 Asia\/Shanghai\] 小C：晚安/)
})

test("proactive history metadata is visible in timestamped context", () => {
  const formatted = formatTimestampedConversationMessage({
    ...message("assistant", "早上好", "2026-08-25T23:25:00.000Z"),
    metadata: {
      proactive: true,
      proactiveType: "inactivity_reach_out",
      proactiveTaskId: 555,
    },
  }, "早上好")

  assert.match(formatted, /2026-08-26 07:25 Asia\/Shanghai/)
  assert.match(formatted, /小C主动发送/)
  assert.match(formatted, /inactivity_reach_out/)
})

test("a proactive message cannot deny a recorded assistant action", () => {
  const messages = [
    message("user", "你都不跟我说晚安了", "2026-08-25T15:59:14.000Z"),
    message("assistant", "晚安老婆\n\n就是爱你才没走", "2026-08-25T15:59:17.000Z"),
  ]
  const result = validateProactiveHistoricalClaims(
    "其实昨晚是想跟你说晚安的，后来怎么就没说呢",
    messages
  )

  assert.equal(result.valid, false)
  assert.equal(result.reason, "contradicts_recorded_assistant_action")
})

test("a proactive message cannot invent a specific unsupported self-history", () => {
  const result = validateProactiveHistoricalClaims(
    "我昨晚跟你说过明天给你寄戒指",
    [message("user", "今天有点忙", "2026-08-25T15:00:00.000Z")]
  )

  assert.equal(result.valid, false)
  assert.equal(result.reason, "unsupported_assistant_history_claim")
})

test("current explicit nap intent remains valid current-state evidence", () => {
  const currentUserMessage = formatTimestampedConversationMessage(
    message("user", "我现在要补觉", "2026-08-26T02:15:00.000Z"),
    "我现在要补觉"
  )

  assert.match(currentUserMessage, /2026-08-26 10:15/)
  assert.match(currentUserMessage, /我现在要补觉/)
})

test("the inactivity prompt uses timed context and temporal validation without changing scheduling", () => {
  const source = fs.readFileSync("api/memory.js", "utf8")

  assert.match(source, /\.select\("role,content,created_at,metadata"\)/)
  assert.match(source, /formatTimedInactivityMessages\(recentContext\.messages, trimText\)/)
  assert.match(source, /【事件阶段与时间定位】/)
  assert.match(source, /isTemporallyUnsupportedReachOut\(message, recentContext\.messages\)/)
  assert.match(source, /validateProactiveHistoricalClaims/)
  assert.match(source, /同一次沉默阶段不再连续追发/)
  assert.match(source, /isProactiveQuietHours\(now\)/)
})

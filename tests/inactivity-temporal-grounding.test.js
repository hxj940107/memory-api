import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import {
  formatTimedInactivityMessages,
  getInactivityEventEvidence,
  isTemporallyUnsupportedReachOut,
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

test("the inactivity prompt uses timed context and temporal validation without changing scheduling", () => {
  const source = fs.readFileSync("api/memory.js", "utf8")

  assert.match(source, /\.select\("role,content,created_at"\)/)
  assert.match(source, /formatTimedInactivityMessages\(recentContext\.messages, trimText\)/)
  assert.match(source, /【事件阶段与时间定位】/)
  assert.match(source, /isTemporallyUnsupportedReachOut\(message, recentContext\.messages\)/)
  assert.match(source, /enqueueNextInactivityReachOutTask\(task, result\)/)
  assert.match(source, /isProactiveQuietHours\(now\)/)
})

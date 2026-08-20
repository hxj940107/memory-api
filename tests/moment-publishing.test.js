import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  isInvalidMomentText,
  isMomentTechnicalDiscussion,
  isMomentWritingRequest,
} from "../lib/momentPublishing.js"

test("recognizes only explicit manual Moment publishing requests", () => {
  assert.equal(isMomentWritingRequest("发一条朋友圈"), true)
  assert.equal(isMomentWritingRequest("写个动态"), true)
  assert.equal(isMomentWritingRequest("来一条朋友圈"), true)
  assert.equal(isMomentWritingRequest("更新一下朋友圈"), true)
  assert.equal(isMomentWritingRequest("朋友圈，给我发一条"), true)
  assert.equal(isMomentWritingRequest("先不讨论逻辑了，现在发一条朋友圈"), true)
})

test("does not confuse Moment product discussion with a publishing request", () => {
  const discussions = [
    "朋友圈要不要做主动触发",
    "朋友圈发布逻辑怎么改",
    "测试一下朋友圈触发",
    "朋友圈功能有bug",
    "朋友圈代码",
    "朋友圈生成逻辑",
    "朋友圈主动触发一下",
  ]

  for (const message of discussions) {
    assert.equal(isMomentWritingRequest(message), false, message)
    assert.equal(isMomentTechnicalDiscussion(message), true, message)
  }
})

test("rejects classifier labels and structured output fragments as Moment text", () => {
  assert.equal(isInvalidMomentText("real person"), true)
  assert.equal(isInvalidMomentText('<thinking>判断是否发布</thinking>'), true)
  assert.equal(isInvalidMomentText('"shouldPost": true'), true)
  assert.equal(isInvalidMomentText('{"text":"今天风挺舒服的"}'), true)
  assert.equal(isInvalidMomentText({ text: "今天风挺舒服的" }), true)
  assert.equal(isInvalidMomentText("系统提示：直接输出正文"), true)
})

test("allows normal Chinese Moment text", () => {
  assert.equal(isInvalidMomentText("今天风挺舒服的，走回来的。"), false)
  assert.equal(isInvalidMomentText("路边那只猫又坐在那里。"), false)
})

test("pending candidate worker validates text before publishing", () => {
  const source = fs.readFileSync(
    new URL("../api/memory.js", import.meta.url),
    "utf8",
  )
  const workerStart = source.indexOf("async function checkPendingMomentCandidates()")
  const workerEnd = source.indexOf("async function checkPendingMomentsForXiaoC()")
  const worker = source.slice(workerStart, workerEnd)
  const validationIndex = worker.indexOf("isInvalidMomentText(candidate.text)")
  const publishIndex = worker.indexOf('.from("moment_entries")')

  assert.ok(validationIndex >= 0)
  assert.ok(publishIndex > validationIndex)
  assert.match(worker, /status: "skipped"[\s\S]*skip_reason: "候选正文未通过发布校验"/)
})

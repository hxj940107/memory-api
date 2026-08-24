import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  isInvalidMomentText,
  isMomentTechnicalDiscussion,
  isMomentWritingRequest,
  parseMomentCandidate,
} from "../lib/momentPublishing.js"
import { isMomentImageCompatible } from "../lib/momentImageLibrary.js"

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

test("distinguishes malformed Moment model output from a model decline", () => {
  const malformed = parseMomentCandidate("不是 JSON")
  const declined = parseMomentCandidate('{"shouldPost":false}')

  assert.equal(malformed.parseFailed, true)
  assert.equal(malformed.shouldPost, null)
  assert.match(malformed.errorSummary, /Unexpected token|JSON/)
  assert.equal(declined.parseFailed, false)
  assert.equal(declined.shouldPost, false)
})

test("automatic Moment prompt encourages concrete life moments without default denial", () => {
  const source = fs.readFileSync(new URL("../api/chat.js", import.meta.url), "utf8")

  assert.doesNotMatch(source, /自动模式下默认 shouldPost: false/)
  assert.doesNotMatch(source, /连续几天没有动态完全正常/)
  assert.match(source, /具体、可复述的生活事件、原话、互动反差、明确情绪/)
  assert.match(source, /事件时间不够精确时，不要仅因此拒绝/)
  assert.match(source, /这条用户消息的 created_at/)
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

test("allows environmental night scenes without literal keyword overlap", () => {
  const images = [
    {
      id: "residential-road",
      description: "夜晚小区里的普通道路",
      timePeriods: ["evening", "night"],
      keywords: ["道路", "小区"],
    },
    {
      id: "streetlight",
      description: "路灯照亮的安静街景",
      timePeriods: ["evening", "night"],
      keywords: ["路灯", "街景"],
    },
    {
      id: "night-street",
      description: "普通夜间城市街道环境",
      timePeriods: ["evening", "night"],
      keywords: ["城市", "街道"],
    },
  ]

  for (const image of images) {
    assert.equal(
      isMomentImageCompatible(
        image.id,
        "晚上出去走了一圈。",
        20,
        images,
        "她说晚上想出去散步。",
      ),
      true,
      image.id,
    )
  }
})

test("uses description to reject an ungrounded independent subject", () => {
  const images = [{
    id: "cat-subject",
    description: "夜路中间蹲着一只很显眼的猫",
    timePeriods: ["evening", "night"],
    keywords: ["生活"],
  }]

  assert.equal(
    isMomentImageCompatible(
      "cat-subject",
      "晚上出去走了一圈。",
      20,
      images,
      "她说晚上想出去散步。",
    ),
    false,
  )
})

test("rejects obvious unsupported weather and time conflicts", () => {
  const images = [
    {
      id: "rainy-road",
      description: "雨夜道路，地面有明显积水",
      timePeriods: ["evening", "night"],
      keywords: ["道路"],
    },
    {
      id: "day-road",
      description: "阳光下的白天街道",
      timePeriods: ["morning", "daytime"],
      keywords: ["道路"],
    },
  ]
  const source = "她说晚上想出去散步。"

  assert.equal(
    isMomentImageCompatible("rainy-road", "晚上出去走了一圈。", 20, images, source),
    false,
  )
  assert.equal(
    isMomentImageCompatible("day-road", "晚上出去走了一圈。", 20, images, source),
    false,
  )
})

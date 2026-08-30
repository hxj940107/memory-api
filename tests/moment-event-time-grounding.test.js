import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import {
  formatMomentSourceTimes,
  normalizeMomentCandidateForPublish,
  normalizeMomentEventTime,
} from "../lib/momentEventTime.js"
import { parseMomentCandidate } from "../lib/momentPublishing.js"
import {
  buildMomentSourceMaterials,
  resolveMomentSourceMaterial,
} from "../lib/momentSourceMaterials.js"

test("immediate candidate corrects an eight-hour offset replacement", () => {
  const result = normalizeMomentEventTime({
    shareMode: "immediate",
    modelEventTime: "2026-08-25T11:31:25+08:00",
    sourceMessageCreatedAt: "2026-08-25T11:31:25Z",
  })

  assert.equal(result.eventTime, "2026-08-25T11:31:25.000Z")
  assert.equal(result.modelEventTime, "2026-08-25T03:31:25.000Z")
  assert.equal(result.differenceMs, 8 * 60 * 60 * 1000)
  assert.equal(result.corrected, true)
})

test("a correct immediate model time is not marked as corrected", () => {
  const result = normalizeMomentEventTime({
    shareMode: "immediate",
    modelEventTime: "2026-08-25T19:31:25+08:00",
    sourceMessageCreatedAt: "2026-08-25T11:31:25Z",
  })

  assert.equal(result.eventTime, "2026-08-25T11:31:25.000Z")
  assert.equal(result.corrected, false)
  assert.equal(result.differenceMs, 0)
})

test("a delayed candidate keeps a valid historical event time", () => {
  const result = normalizeMomentEventTime({
    shareMode: "delayed",
    modelEventTime: "2026-08-24T21:00:00+08:00",
    sourceMessageCreatedAt: "2026-08-25T11:31:25Z",
  })

  assert.equal(result.eventTime, "2026-08-24T13:00:00.000Z")
  assert.equal(result.corrected, false)
})

test("source time is shown as UTC and Shanghai for the same instant", () => {
  const formatted = formatMomentSourceTimes("2026-08-25T11:31:25Z")

  assert.equal(formatted.utc, "2026-08-25T11:31:25.000Z")
  assert.equal(formatted.shanghai, "2026-08-25T19:31:25+08:00")
  assert.equal(new Date(formatted.utc).getTime(), new Date(formatted.shanghai).getTime())
})

test("a paid candidate is converted to delayed voice when its publish window crosses a day", () => {
  const result = normalizeMomentCandidateForPublish({
    text: "刚刚她说要开始 debug。",
    shareMode: "immediate",
    eventTime: "2026-08-28T22:50:00+08:00",
  }, "2026-08-29T09:20:00+08:00")

  assert.equal(result.corrected, true)
  assert.equal(result.candidate.shareMode, "delayed")
  assert.equal(result.candidate.text, "突然想起，她说要开始 debug。")
  assert.equal(result.correctionReason, "publish_window_requires_delayed_voice")
})

test("a near-term candidate keeps its original voice", () => {
  const result = normalizeMomentCandidateForPublish({
    text: "在等，有点无聊。",
    shareMode: "immediate",
    eventTime: "2026-08-29T14:00:00+08:00",
  }, "2026-08-29T15:00:00+08:00")

  assert.equal(result.corrected, false)
  assert.equal(result.candidate.shareMode, "immediate")
  assert.equal(result.candidate.text, "在等，有点无聊。")
})

test("Moment prompt and audit log expose source and normalized times", () => {
  const source = fs.readFileSync("api/chat.js", "utf8")

  assert.match(source, /source_message_created_at_utc/)
  assert.match(source, /source_message_created_at_shanghai/)
  assert.match(source, /normalizeMomentEventTime/)
  assert.match(source, /MOMENT EVENT TIME AUDIT:/)
  assert.match(source, /fallbackApplied: eventTimeGrounding\.corrected/)
})

test("worker time consistency protection remains unchanged", () => {
  const source = fs.readFileSync("api/memory.js", "utf8")

  assert.match(source, /if \(eventMs > publishMs \+ 30 \* 60 \* 1000\)/)
  assert.match(source, /ageMs > 3 \* 60 \* 60 \* 1000/)
  assert.match(source, /过去事件被标记为即时记录/)
  assert.match(source, /normalizeMomentCandidateForPublish/)
})

test("automatic Moment generation stays low-frequency but publication limits do not erase material", () => {
  const config = fs.readFileSync("lib/aiConfig.js", "utf8")
  const source = fs.readFileSync("api/chat.js", "utf8")

  assert.match(config, /momentCheckIntervalMinutes: 180/)
  assert.match(source, /getAutomaticMomentGenerationReadiness/)
  assert.doesNotMatch(source, /reason: "recent_moment_cooldown"/)
  assert.doesNotMatch(source, /reason: "pending_candidate_exists"/)
  assert.match(source, /Publication cooldown, daily capacity and pending-pool replacement/)
  assert.match(source, /自动模式必须返回一条有当前对话依据的候选/)
})

test("Moment judge can select a recent user source with persisted image evidence", () => {
  const materials = buildMomentSourceMaterials([
    {
      id: "message-app",
      role: "user",
      content: "赶在出门前搞定了！",
      created_at: "2026-08-30T04:20:54Z",
      metadata: { imageDescription: "XiaoC App 已经安装在 iPhone 上" },
    },
    {
      id: "assistant-app",
      role: "assistant",
      content: "终于装好了。",
      created_at: "2026-08-30T04:21:00Z",
      metadata: {},
    },
    {
      id: "message-dog",
      role: "user",
      content: "改吃烤肉了，看餐厅门口的小狗",
      created_at: "2026-08-30T05:04:01Z",
      metadata: { imageDescription: "餐厅门口趴着一只柯基" },
    },
  ])

  assert.equal(materials.length, 2)
  assert.equal(materials[1].alias, "u2")
  assert.equal(materials[1].imageDescription, "餐厅门口趴着一只柯基")
  assert.equal(resolveMomentSourceMaterial(materials, "u2")?.messageId, "message-dog")
  assert.equal(resolveMomentSourceMaterial(materials, "message-app")?.alias, "u1")
  assert.equal(resolveMomentSourceMaterial(materials, "unknown"), null)
})

test("current image evidence overrides a not-yet-persisted metadata description", () => {
  const materials = buildMomentSourceMaterials([
    {
      id: "message-icecream",
      role: "user",
      content: "吃完了，还吃了个免费小甜筒",
      created_at: "2026-08-30T06:12:54Z",
      metadata: {},
    },
  ], {
    currentUserMessageId: "message-icecream",
    currentImageDescription: "烤肉和软冰淇淋甜筒",
  })

  assert.equal(materials[0].imageDescription, "烤肉和软冰淇淋甜筒")
})

test("Moment candidate parser keeps the selected source alias", () => {
  const candidate = parseMomentCandidate(JSON.stringify({
    shouldPost: true,
    source_message_id: "u2",
    text: "出门吃饭，先在门口被这只拦住了。",
    image: "album:12",
    priority: 3,
    share_mode: "immediate",
    event_time: "2026-08-30T13:04:01+08:00",
  }))

  assert.equal(candidate.parseFailed, false)
  assert.equal(candidate.sourceMessageId, "u2")
})

test("Moment admission validates selected provenance and saves the real user source", () => {
  const source = fs.readFileSync("api/chat.js", "utf8")

  assert.match(source, /resolveMomentSourceMaterial/)
  assert.match(source, /invalid_source_provenance/)
  assert.match(source, /sourceMessageCreatedAt: selectedSource\.createdAt/)
  assert.match(source, /source_message_id: selectedSource\.messageId/)
  assert.match(source, /metadata\?\.imageDescription/)
  assert.match(source, /\.order\("last_used_at", \{ ascending: true, nullsFirst: true \}\)\s*\.order\("created_at", \{ ascending: false \}\)/)
})

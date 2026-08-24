import assert from "node:assert/strict"
import fs from "node:fs"
import { getDiaryContextWindow } from "../lib/diaryContextWindow.js"

const SHANGHAI = "Asia/Shanghai"

{
  const window = getDiaryContextWindow("2026-08-24T04:00:00.000Z", SHANGHAI)
  assert.deepEqual(window, {
    start: "2026-08-23T23:00:00.000Z",
    end: "2026-08-24T04:00:00.000Z",
    timeZone: SHANGHAI,
  })
}

{
  const window = getDiaryContextWindow("2026-08-24T14:30:00.000Z", SHANGHAI)
  assert.equal(window.start, "2026-08-23T23:00:00.000Z")
  assert.equal(window.end, "2026-08-24T14:30:00.000Z")
}

{
  const window = getDiaryContextWindow("2026-08-24T17:30:00.000Z", SHANGHAI)
  assert.equal(window.start, "2026-08-23T23:00:00.000Z")
  assert.equal(window.end, "2026-08-24T17:30:00.000Z")
}

{
  const beforeBoundary = getDiaryContextWindow("2026-08-23T22:59:59.000Z", SHANGHAI)
  const atBoundary = getDiaryContextWindow("2026-08-23T23:00:00.000Z", SHANGHAI)
  assert.equal(beforeBoundary.start, "2026-08-22T23:00:00.000Z")
  assert.equal(atBoundary.start, "2026-08-23T23:00:00.000Z")
}

{
  const triggerAt = "2026-08-24T14:30:00.000Z"
  const window = getDiaryContextWindow(triggerAt, SHANGHAI)
  const messages = [
    "2026-08-23T22:59:59.999Z",
    "2026-08-23T23:00:00.000Z",
    triggerAt,
    "2026-08-24T14:30:00.001Z",
  ]
  const included = messages.filter(value => value >= window.start && value <= window.end)
  assert.deepEqual(included, ["2026-08-23T23:00:00.000Z", triggerAt])
}

{
  const chat = fs.readFileSync("api/chat.js", "utf8")
  assert.match(chat, /\.gte\("created_at", window\.start\)/)
  assert.match(chat, /\.lte\("created_at", window\.end\)/)
  assert.match(chat, /\.order\("created_at", \{ ascending: true \}\)/)
  assert.match(chat, /getDiaryContextMessages\(user_id, cid, diaryTriggerAt\)/)
}

console.log("diary context window tests passed")

import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import {
  formatMomentSourceTimes,
  normalizeMomentEventTime,
} from "../lib/momentEventTime.js"

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
})

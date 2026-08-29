import assert from "node:assert/strict"
import fs from "node:fs"
import {
  BACKGROUND_PROCESSING_STALE_MS,
  getMarkedRetryCount,
  getPayloadRetryCount,
  isStaleProcessingTimestamp,
  planBackgroundFailure,
  stripRetryMarker,
  withRetryMarker,
} from "../lib/backgroundTaskReliability.js"

assert.equal(BACKGROUND_PROCESSING_STALE_MS, 15 * 60 * 1000)
assert.equal(planBackgroundFailure({ type: "inactivity_reach_out" }).status, "pending")
assert.equal(planBackgroundFailure({
  type: "inactivity_reach_out",
  previousAttempts: 2,
}).status, "failed")
assert.equal(planBackgroundFailure({
  type: "treehole_autonomous_update",
  previousAttempts: 1,
}).status, "failed")
assert.equal(getPayloadRetryCount({ proactive_attention_send_attempt_count: 2 }), 2)
assert.equal(getPayloadRetryCount({
  background_retry_count: 1,
  proactive_attention_send_attempt_count: 2,
}), 2)

const marked = withRetryMarker("provider failed", 2)
assert.equal(getMarkedRetryCount(marked), 2)
assert.equal(stripRetryMarker(marked), "provider failed")
assert.equal(isStaleProcessingTimestamp(
  "2026-08-29T08:00:00.000Z",
  new Date("2026-08-29T08:16:00.000Z"),
), true)
assert.equal(isStaleProcessingTimestamp(
  "2026-08-29T08:10:00.000Z",
  new Date("2026-08-29T08:16:00.000Z"),
), false)

const memory = fs.readFileSync("api/memory.js", "utf8")
assert.match(memory, /stale processing claim recovered/)
assert.match(memory, /background_retry_count/)
assert.match(memory, /status: failurePlan\.status/)
assert.match(memory, /metadata->>proactiveTaskId/)

const chat = fs.readFileSync("api/chat.js", "utf8")
assert.doesNotMatch(chat, /void \(async \(\) =>/)
assert.match(chat, /waitUntil\(\(async \(\) =>/)
assert.doesNotMatch(chat, /visionSummary: reply/)
assert.doesNotMatch(chat, /metadata\?\.imageDescription \|\| item\.metadata\?\.visionSummary/)

console.log("background task reliability tests passed")

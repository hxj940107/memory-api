import assert from "node:assert/strict"
import fs from "node:fs"

import {
  BP1_CACHE_KEEPALIVE_DELAY_MINUTES,
  BP1_CACHE_KEEPALIVE_TASK_TYPE,
  buildBp1CacheKeepaliveSuffix,
  evaluateBp1CacheKeepaliveActivity,
  getBp1CacheKeepaliveDueAt,
  isCurrentKeepaliveActivity,
} from "../lib/cacheKeepalive.js"
import { buildCachedPromptMessages, buildStablePromptMessage } from "../lib/promptCaching.js"

assert.equal(BP1_CACHE_KEEPALIVE_DELAY_MINUTES, 47)
assert.equal(
  getBp1CacheKeepaliveDueAt("2026-09-26T00:00:00.000Z"),
  "2026-09-26T00:47:00.000Z",
)

const activityTask = {
  source_id: "message-2",
  conversation_id: "conversation-1",
}
assert.equal(isCurrentKeepaliveActivity(activityTask, {
  id: "message-2",
  conversation_id: "conversation-1",
}), true)
assert.equal(isCurrentKeepaliveActivity(activityTask, {
  id: "message-3",
  conversation_id: "conversation-1",
}), false)
assert.equal(isCurrentKeepaliveActivity(activityTask, null), false)

const timedTask = {
  ...activityTask,
  payload: { activity_at: "2026-09-26T00:00:00.000Z" },
}
const latestActivity = {
  id: "message-2",
  conversation_id: "conversation-1",
  created_at: "2026-09-26T00:00:00.000Z",
}
assert.equal(evaluateBp1CacheKeepaliveActivity(
  timedTask,
  latestActivity,
  new Date("2026-09-26T00:44:59.000Z"),
).reason, "main_chat_activity_too_recent")
assert.equal(evaluateBp1CacheKeepaliveActivity(
  timedTask,
  latestActivity,
  new Date("2026-09-26T00:47:00.000Z"),
).eligible, true)
assert.equal(evaluateBp1CacheKeepaliveActivity(
  timedTask,
  latestActivity,
  new Date("2026-09-26T00:50:01.000Z"),
).reason, "main_chat_activity_no_longer_active")

const stableInput = {
  persona: "persona",
  relationshipContract: "relationship",
  coreMemorySnapshot: "frozen core",
  fixedRules: "fixed rules",
}
const mainStable = buildCachedPromptMessages({
  ...stableInput,
  foldedHistory: "folded",
  history: [{ role: "user", content: "history" }],
  dynamicContext: "dynamic",
})[0]
assert.deepEqual(buildStablePromptMessage(stableInput), mainStable)
assert.deepEqual(buildBp1CacheKeepaliveSuffix(), {
  role: "user",
  content: "<xiaoc_cache_keepalive />",
})

const chat = fs.readFileSync("api/chat.js", "utf8")
const memory = fs.readFileSync("api/memory.js", "utf8")
const keepaliveBranch = chat.indexOf(`req.body?.action === BP1_CACHE_KEEPALIVE_TASK_TYPE`)
const saveUserMessage = chat.indexOf("const userMessageId = await saveUserMessage")
assert.ok(keepaliveBranch > 0 && keepaliveBranch < saveUserMessage)
assert.match(chat, /readStoredCoreMemorySnapshot/)
assert.match(chat, /\[stableMessage, buildBp1CacheKeepaliveSuffix\(\)\]/)
assert.match(chat, /max_tokens: 1, temperature: 0, session_id: cid/)
assert.match(chat, /actorType !== "cron"/)
assert.match(chat, /enqueueBp1CacheKeepalive/)
assert.match(chat, /superseded_by_new_main_chat_activity/)

assert.match(memory, /evaluateBp1CacheKeepaliveActivity\(task, latestUserMessage\)/)
assert.match(memory, /keepalive_request_failed/)
assert.match(memory, /shadowOnly: true/)
assert.match(memory, new RegExp(BP1_CACHE_KEEPALIVE_TASK_TYPE))
assert.doesNotMatch(memory, /BP1_CACHE_KEEPALIVE_TASK_TYPE[\s\S]{0,800}saveProactiveMessage/)

console.log("cache keepalive tests passed")

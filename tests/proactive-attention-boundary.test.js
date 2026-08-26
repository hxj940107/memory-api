import assert from "node:assert/strict"
import fs from "node:fs"

const chat = fs.readFileSync("api/chat.js", "utf8")
const productionSources = [
  chat,
  fs.readFileSync("lib/mainChatContext.js", "utf8"),
  fs.readFileSync("lib/dynamicMemoryFilter.js", "utf8"),
].join("\n")

// Active Context still has its own update path and keeps the existing single
// lightweight model decision. It no longer emits a proactive plan decision.
const judgeStart = chat.indexOf("async function judgeActiveConversationContext")
const updateStart = chat.indexOf("async function updateActiveConversationContext")
const judgeSource = chat.slice(judgeStart, updateStart)
assert.ok(judgeStart >= 0)
assert.ok(updateStart > judgeStart)
assert.equal((judgeSource.match(/callLLM\(/g) || []).length, 1)
assert.match(judgeSource, /active_context/)
assert.doesNotMatch(judgeSource, /plan_follow_up|should_follow_up/)

// Explicit plans no longer have any automatic plan task creation path.
assert.doesNotMatch(chat, /enqueuePlanFollowUpTask/)
assert.doesNotMatch(chat, /type:\s*["']plan_follow_up["']/)
assert.doesNotMatch(chat, /PLAN FOLLOW-UP QUEUED/)

// Inactivity scheduling is independent of Active Context success and is not
// hidden behind a plan-task branch.
const schedulingStart = chat.indexOf("await updateActiveConversationContext({")
const schedulingSource = chat.slice(schedulingStart, schedulingStart + 1800)
assert.match(schedulingSource, /active conversation context update failed/)
assert.match(schedulingSource, /enqueueInactivityReachOutTask/)
assert.match(schedulingSource, /inactivity reach-out enqueue failed/)
assert.doesNotMatch(schedulingSource, /if \(planTask\)|else\s*\{[\s\S]*enqueueInactivityReachOutTask/)

// Removed compatibility helpers and aliases must not remain in production.
assert.doesNotMatch(productionSources, /filterContextEntries/)
assert.doesNotMatch(productionSources, /filterDynamicMemorySearchText/)
assert.doesNotMatch(productionSources, /suppressionTexts/)

console.log("proactive attention boundary tests passed")

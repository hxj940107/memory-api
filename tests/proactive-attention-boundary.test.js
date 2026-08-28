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
assert.match(judgeSource, /proactive_event_proposals/)
assert.match(judgeSource, /周五早上要考试了[^]*捕获1个 planned 事件/)
assert.match(judgeSource, /周日中午和朋友吃饭，下午去做脸[^]*捕获2个独立事件/)
assert.match(judgeSource, /明天一早交销量表，然后做客户信息统计[^]*捕获2个独立事件/)
assert.match(judgeSource, /我去洗澡等会回来[^]*通常返回空数组/)
assert.doesNotMatch(judgeSource, /plan_follow_up|should_follow_up/)

// Explicit plans no longer have any automatic plan task creation path.
assert.doesNotMatch(chat, /enqueuePlanFollowUpTask/)
assert.doesNotMatch(chat, /type:\s*["']plan_follow_up["']/)
assert.doesNotMatch(chat, /PLAN FOLLOW-UP QUEUED/)
assert.doesNotMatch(chat, /type:\s*["']proactive_attention["']/)
assert.doesNotMatch(chat, /PROACTIVE ATTENTION QUEUED/)

// Inactivity scheduling is independent of Active Context success and is not
// hidden behind a plan-task branch.
const schedulingStart = chat.indexOf("await updateActiveConversationContext({")
const schedulingSource = chat.slice(schedulingStart, schedulingStart + 2600)
assert.match(schedulingSource, /active conversation context update failed/)
assert.match(schedulingSource, /enqueueInactivityReachOutTask/)
assert.match(schedulingSource, /inactivity reach-out enqueue failed/)
assert.doesNotMatch(schedulingSource, /if \(planTask\)|else\s*\{[\s\S]*enqueueInactivityReachOutTask/)
assert.match(chat, /proactiveAttentionCandidates/)
assert.match(chat, /proactiveAttentionDiagnostics/)
assert.match(chat, /mode: "shadow"/)
assert.match(schedulingSource, /contextual_assistant_message/)
assert.match(schedulingSource, /lastHistoryMessage\?\.role !== "assistant"/)
assert.match(schedulingSource, /is_immediately_previous: true/)

// Removed compatibility helpers and aliases must not remain in production.
assert.doesNotMatch(productionSources, /filterContextEntries/)
assert.doesNotMatch(productionSources, /filterDynamicMemorySearchText/)
assert.doesNotMatch(productionSources, /suppressionTexts/)

console.log("proactive attention boundary tests passed")

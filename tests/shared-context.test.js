import assert from "node:assert/strict"
import fs from "node:fs"
import {
  emptySharedWorkingContext,
  formatSharedContextForPrompt,
  normalizeSharedContext,
  parseSharedContextUpdate,
  selectPendingSharedContextMessages,
  shouldUpdateSharedContext,
} from "../lib/sharedContext.js"
import { allocateDynamicContextBudget } from "../lib/dynamicContextBudget.js"

const context = normalizeSharedContext({
  id: "shared-book",
  title: "一起读《挪威的森林》",
  kind: "reading",
  status: "active",
  working_context: {
    progress: "读到第三章",
    user_views: ["她觉得直子一直在回避真正的问题"],
    xiaoc_views: ["小C认为沉默本身也是人物关系的一部分"],
    open_questions: ["第三章的沉默意味着什么"],
    source_message_ids: ["user-1", "assistant-1"],
  conversation_checkpoints: { "conversation-a": "assistant-1" },
  },
})

assert.ok(context)
assert.match(formatSharedContextForPrompt(context), /读到第三章/)
assert.match(formatSharedContextForPrompt(context), /她的观点/)
assert.equal(formatSharedContextForPrompt({ ...context, status: "archived" }), "")
assert.deepEqual(emptySharedWorkingContext().source_message_ids, [])

const unboundBudget = allocateDynamicContextBudget({ totalChars: 7600 })
const boundBudget = allocateDynamicContextBudget({ totalChars: 7600, hasSharedContext: true })
assert.equal(unboundBudget.shared, 0)
assert.ok(boundBudget.shared > 0)
assert.equal(
  Object.entries(boundBudget)
    .filter(([key]) => ["recent", "active", "shared", "summary", "memory", "ledger", "web"].includes(key))
    .reduce((total, [, value]) => total + value, 0),
  7600,
)

const messages = Array.from({ length: 12 }, (_, index) => ({
  id: index % 2 === 0 ? `user-${index / 2 + 1}` : `assistant-${(index + 1) / 2}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: `message ${index + 1}`,
}))
assert.equal(shouldUpdateSharedContext(messages).shouldUpdate, true)
assert.equal(shouldUpdateSharedContext(messages.slice(0, 8)).shouldUpdate, false)
assert.equal(shouldUpdateSharedContext(messages.slice(0, 2), { force: true }).shouldUpdate, true)

const pending = selectPendingSharedContextMessages(messages, {
  ...emptySharedWorkingContext(),
  conversation_checkpoints: { "conversation-a": "assistant-2" },
}, "conversation-a")
assert.equal(pending[0].id, "user-3")

const parsed = parseSharedContextUpdate(JSON.stringify({
  progress: "读到第四章",
  recent_decisions: ["下次继续讨论直子"],
  user_views: ["她更关注人物的回避"],
  xiaoc_views: ["小C更关注沉默的作用"],
  open_questions: ["直子为什么离开"],
  latest_update: "完成第四章讨论",
  field_sources: {
    progress: ["user-6"],
    recent_decisions: ["user-6", "assistant-6"],
    user_views: ["user-6"],
    xiaoc_views: ["assistant-6"],
    open_questions: ["assistant-6"],
    latest_update: ["user-6", "assistant-6"],
  },
}), context.working_context, messages, "conversation-a")
assert.equal(parsed.progress, "读到第四章")
assert.equal(parsed.conversation_checkpoints["conversation-a"], "assistant-6")
assert.deepEqual(parsed.source_message_ids, ["user-1", "assistant-1", "user-6", "assistant-6"])
assert.equal(parseSharedContextUpdate(JSON.stringify({
  progress: "猜出来的进度",
  field_sources: { progress: ["invented-message"] },
}), context.working_context, messages, "conversation-a"), null)
assert.equal(parseSharedContextUpdate(JSON.stringify({
  user_views: ["把小C的话当成用户观点"],
  field_sources: { user_views: ["assistant-6"] },
}), context.working_context, messages, "conversation-a"), null)

const chat = fs.readFileSync("api/chat.js", "utf8")
const memory = fs.readFileSync("api/memory.js", "utf8")
assert.match(chat, /hasSharedContext: Boolean\(sharedContext\)/)
assert.match(chat, /formatSharedContextForPrompt/)
assert.match(chat, /sharedContextPrompt \? \[sharedContextPrompt\]/)
assert.match(chat, /SHARED_CONTEXT_UPDATE_TURN_THRESHOLD|shouldUpdateSharedContext/)
assert.doesNotMatch(chat, /sharedContext[\s\S]{0,80}proactiveEventProposals/)
assert.match(memory, /type === "shared_context"/)
assert.match(memory, /action === "create"/)
assert.match(memory, /action === "bind"/)
assert.match(memory, /action === "unbind"/)
assert.match(memory, /eq\("status", "active"\)/)
assert.match(memory, /ensureSharedContextConversation/)

const mobileChat = fs.readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")
assert.match(mobileChat, /const draftConversationId = `chat_\$\{Date\.now\(\)\}`/)
assert.match(mobileChat, /conversationTitleInitializedRef/)

console.log("shared context tests passed")

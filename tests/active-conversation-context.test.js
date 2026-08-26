import assert from "node:assert/strict"
import fs from "node:fs"
import {
  ACTIVE_CONTEXT_MAX_CHARS,
  ACTIVE_CONTEXT_MAX_ITEMS,
  formatActiveConversationContext,
  normalizeActiveConversationContext,
  resolveActiveConversationContext,
} from "../lib/activeConversationContext.js"

const exam = {
  topic: "周五公司内部考试",
  context: "她今天才开始刷题，考试内容与公司和产品有关",
  status: "active",
  kind: "plan",
  source_message_id: "message-exam",
  last_referenced_message_id: "message-exam",
  missed_turns: 0,
}

{
  const context = normalizeActiveConversationContext({ items: [exam] })
  assert.deepEqual(context.items, [exam])
}

{
  const previous = { items: [exam] }
  const afterTopicSwitch = resolveActiveConversationContext(previous, {
    items: [exam],
  })
  assert.equal(afterTopicSwitch.items[0].topic, exam.topic)
  assert.equal(afterTopicSwitch.items[0].missed_turns, 1)
}

{
  const trip = {
    topic: "近期旅行",
    context: "她正在确认出发安排",
    status: "waiting",
    kind: "waiting",
    source_message_id: "message-trip",
    last_referenced_message_id: "message-trip",
    missed_turns: 0,
  }
  const result = resolveActiveConversationContext({ items: [exam] }, {
    items: [exam, trip],
  })
  assert.equal(result.items.length, 2)
  assert.equal(result.items[1].topic, "近期旅行")
}

{
  const completed = resolveActiveConversationContext({ items: [exam] }, { items: [] })
  assert.deepEqual(completed, { items: [] })
}

{
  const updatedExam = {
    ...exam,
    context: "她已经刷完公司知识部分，接下来准备看产品题",
  }
  const result = resolveActiveConversationContext({ items: [exam] }, {
    items: [updatedExam],
  })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].context, updatedExam.context)
}

{
  const transient = {
    topic: "午餐咖喱",
    context: "她今天中午吃了咖喱牛肉，已经聊完",
    status: "active",
    kind: "transient",
    source_message_id: "message-curry",
    last_referenced_message_id: "message-curry",
    missed_turns: 2,
  }
  const result = resolveActiveConversationContext(
    { items: [transient, exam] },
    { items: [transient, exam] },
    { currentUserMessageId: "message-new-topic" }
  )
  assert.doesNotMatch(JSON.stringify(result), /午餐咖喱/)
  assert.match(JSON.stringify(result), /周五公司内部考试/)
}

{
  const greetingResult = resolveActiveConversationContext(
    { items: [exam] },
    { items: [exam] }
  )
  assert.equal(greetingResult.items[0].topic, exam.topic)
}

{
  const oversized = {
    items: Array.from({ length: 8 }, (_, index) => ({
      topic: `事项${index}`,
      context: "很长的具体信息".repeat(30),
      status: "active",
    })),
  }
  const normalized = normalizeActiveConversationContext(oversized)
  const usedChars = normalized.items.reduce(
    (total, item) => total + item.topic.length + item.context.length,
    0
  )
  assert.ok(normalized.items.length <= ACTIVE_CONTEXT_MAX_ITEMS)
  assert.ok(usedChars <= ACTIVE_CONTEXT_MAX_CHARS)
}

{
  const previous = { items: [exam] }
  assert.deepEqual(resolveActiveConversationContext(previous, null), previous)
  assert.deepEqual(resolveActiveConversationContext(previous, { bad: true }), previous)
}

{
  const prompt = formatActiveConversationContext({ items: [exam] })
  assert.match(prompt, /Active Conversation Context/)
  assert.match(prompt, /周五公司内部考试/)
  assert.match(prompt, /不要逐条复述/)
}

{
  const prompt = formatActiveConversationContext(
    { items: [exam] },
    { recentMessageIds: ["message-exam"] }
  )
  assert.equal(prompt, "")
}

{
  const chat = fs.readFileSync("api/chat.js", "utf8")
  const judgeStart = chat.indexOf("async function judgePlanFollowUp")
  const enqueueStart = chat.indexOf("async function enqueuePlanFollowUpTask")
  const judgeSource = chat.slice(judgeStart, enqueueStart)

  assert.match(chat, /metadata\?\.activeConversationContext/)
  assert.match(chat, /activeConversationContext: normalized/)
  assert.match(chat, /\$\{activeConversationContextPrompt\}/)
  assert.match(chat, /previous_active_context: activeConversationContext/)
  assert.match(chat, /persist_active_context: canPersistActiveConversationContext/)
  assert.match(chat, /if \(persist_active_context\)/)
  assert.equal((judgeSource.match(/callLLM\(/g) || []).length, 1)
  assert.match(judgeSource, /planDecision: conversationalGoodbye/)
  assert.match(judgeSource, /normalizePlanFollowUpDecision\(parsed\?\.plan_follow_up \|\| parsed\)/)
  assert.match(
    judgeSource,
    /activeContext: conversationalGoodbye[\s\S]*resolveActiveConversationContext\(previousActiveContext, previousActiveContext/
  )
  assert.match(chat, /decision = decision \|\| buildRuleBasedPlanFollowUp\(message\)/)
  assert.match(chat, /\.from\("xiaoc_proactive_tasks"\)[\s\S]*\.upsert\(/)
}

{
  const config = fs.readFileSync("lib/aiConfig.js", "utf8")
  assert.match(config, /recentHistoryMessages: 32/)
  assert.match(config, /recentHistoryTokens: 2200/)
}

console.log("active conversation context tests passed")

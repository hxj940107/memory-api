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
    source_evidence: "正在确认出发安排",
  }
  const result = resolveActiveConversationContext({ items: [exam] }, {
    items: [exam, trip],
  }, {
    userSourceLedger: [{
      id: "message-trip",
      role: "user",
      content: "我正在确认出发安排",
    }],
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
  const suppressed = resolveActiveConversationContext({ items: [exam] }, {
    items: [exam],
    mention_preferences: [{
      topic: "右侧腰部疼痛近况",
      action: "suppress",
      scope: "unsolicited_check_in",
      strength: "soft",
      source_message_id: "message-boundary",
      evidence_text: "你别老问",
    }],
  }, {
    currentUserMessageId: "message-boundary",
    userSourceLedger: [{
      id: "message-boundary",
      role: "user",
      content: "没那么严重啦，你别老问",
    }],
  })
  assert.equal(suppressed.mention_preferences.length, 1)
  assert.equal(suppressed.mention_preferences[0].topic, "右侧腰部疼痛近况")
  assert.doesNotMatch(JSON.stringify(suppressed), /evidence_text/)
  assert.match(formatActiveConversationContext(suppressed), /不要把它作为无新证据的主动检查/)

  const carried = resolveActiveConversationContext(suppressed, { items: [exam] })
  assert.equal(carried.mention_preferences.length, 1)

  const released = resolveActiveConversationContext(carried, {
    items: [exam],
    mention_preferences: [{
      topic: "右侧腰部疼痛近况",
      action: "allow",
      scope: "unsolicited_check_in",
      strength: "soft",
      source_message_id: "message-release",
      evidence_text: "这个可以聊了",
    }],
  }, {
    currentUserMessageId: "message-release",
    userSourceLedger: [{
      id: "message-release",
      role: "user",
      content: "这个可以聊了",
    }],
  })
  assert.equal(released.mention_preferences, undefined)
}

{
  const invalid = resolveActiveConversationContext({ items: [exam] }, {
    items: [exam],
    mention_preferences: [{
      topic: "右侧腰部疼痛近况",
      action: "suppress",
      source_message_id: "message-boundary",
      evidence_text: "你别老问",
    }],
  }, {
    currentUserMessageId: "message-boundary",
    userSourceLedger: [{
      id: "message-boundary",
      role: "user",
      content: "没那么严重啦",
    }],
  })
  assert.equal(invalid.mention_preferences, undefined)
}

{
  const backfilled = resolveActiveConversationContext({ items: [exam] }, {
    items: [exam],
    mention_preferences: [{
      topic: "右侧腰部疼痛近况",
      action: "suppress",
      source_message_id: "message-recent-boundary",
      evidence_text: "你别老问",
    }],
  }, {
    currentUserMessageId: "message-current",
    userSourceLedger: [
      { id: "message-recent-boundary", role: "user", content: "没那么严重啦，你别老问" },
      { id: "message-current", role: "user", content: "刚醒" },
    ],
  })
  assert.equal(backfilled.mention_preferences.length, 1)
  assert.equal(backfilled.mention_preferences[0].source_message_id, "message-recent-boundary")

  const staleRelease = resolveActiveConversationContext(backfilled, {
    items: [exam],
    mention_preferences: [{
      topic: "右侧腰部疼痛近况",
      action: "allow",
      source_message_id: "message-old-release",
      evidence_text: "可以再聊",
    }],
  }, {
    currentUserMessageId: "message-current",
    userSourceLedger: [
      { id: "message-old-release", role: "user", content: "可以再聊" },
      { id: "message-current", role: "user", content: "刚醒" },
    ],
  })
  assert.equal(staleRelease.mention_preferences.length, 1)
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
  const judgeStart = chat.indexOf("async function judgeActiveConversationContext")
  const updateStart = chat.indexOf("async function updateActiveConversationContext")
  const judgeSource = chat.slice(judgeStart, updateStart)

  assert.match(chat, /metadata\?\.activeConversationContext/)
  assert.match(chat, /activeConversationContext: normalized/)
  assert.match(chat, /\$\{activeConversationContextPrompt\}/)
  assert.match(chat, /previous_active_context: activeConversationContext/)
  assert.match(chat, /persist_active_context: canPersistActiveConversationContext/)
  assert.match(chat, /if \(persist_active_context\)/)
  assert.equal((judgeSource.match(/callLLM\(/g) || []).length, 1)
  assert.match(
    judgeSource,
    /activeContext: resolveActiveConversationContext\([\s\S]*parsed\.activeContext/
  )
  assert.match(judgeSource, /response_format: \{ type: "json_object" \}/)
  assert.match(chat, /merge_action: "parse_failed"/)
  assert.match(chat, /raw_output_summary/)
  assert.match(judgeSource, /mention_preferences/)
  assert.match(judgeSource, /你别老问/)
  assert.doesNotMatch(judgeSource, /plan_follow_up|should_follow_up/)
  assert.doesNotMatch(chat, /enqueuePlanFollowUpTask|buildRuleBasedPlanFollowUp/)
}

{
  const config = fs.readFileSync("lib/aiConfig.js", "utf8")
  assert.match(config, /recentHistoryMessages: 32/)
  assert.match(config, /recentHistoryTokens: 2200/)
}

{
  const provenanceDiagnostics = []
  const result = resolveActiveConversationContext({ items: [] }, {
    items: [{
      topic: "月末工作堆积，睡眠不足",
      context: "她月末工作很多而且没睡饱",
      status: "active",
      kind: "transient",
      source_message_id: "message-angry",
      last_referenced_message_id: "message-angry",
      source_evidence: "月末工作很多",
    }],
  }, {
    currentUserMessageId: "message-angry",
    userSourceLedger: [{ id: "message-angry", role: "user", content: "好端端的我凶你干嘛" }],
    provenanceDiagnostics,
  })
  assert.deepEqual(result.items, [])
  assert.equal(provenanceDiagnostics[0].rejection_reason, "invalid_source_provenance")
  assert.equal(provenanceDiagnostics[0].validated_source_id, null)
}

{
  const result = resolveActiveConversationContext({ items: [] }, {
    items: [{
      topic: "周五早上考试",
      context: "她周五早上要考试",
      status: "active",
      kind: "plan",
      source_message_id: "message-exam-new",
      last_referenced_message_id: "message-exam-new",
      source_evidence: "周五早上要考试",
    }],
  }, {
    currentUserMessageId: "message-exam-new",
    userSourceLedger: [{ id: "message-exam-new", role: "user", content: "宝宝 我周五早上要考试了" }],
  })
  assert.equal(result.items[0].source_message_id, "message-exam-new")
  assert.equal(result.items[0].missed_turns, 0)
  assert.equal(Object.hasOwn(result.items[0], "source_evidence"), false)
}

{
  const result = resolveActiveConversationContext({ items: [exam] }, {
    items: [{
      ...exam,
      last_referenced_message_id: "message-exam-remention",
      source_evidence: "周五考试准备得怎么样",
      missed_turns: 2,
    }],
  }, {
    currentUserMessageId: "message-exam-remention",
    userSourceLedger: [{
      id: "message-exam-remention",
      role: "user",
      content: "我又想起周五考试准备得怎么样了",
    }],
  })
  assert.equal(result.items[0].source_message_id, "message-exam")
  assert.equal(result.items[0].last_referenced_message_id, "message-exam-remention")
  assert.equal(result.items[0].missed_turns, 0)
}

console.log("active conversation context tests passed")

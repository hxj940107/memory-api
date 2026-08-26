import assert from "node:assert/strict"
import { evaluateContextCandidates } from "../lib/contextEligibility.js"
import { resolveActiveConversationContext } from "../lib/activeConversationContext.js"

function memory(content, extra = {}) {
  return {
    memoryId: extra.memoryId || "ordinary-life-memory",
    candidateId: extra.candidateId || "ordinary-life-memory",
    source: extra.source || "dynamic",
    content,
    ...extra,
  }
}

// A. A small life fact already present in recent dialogue is not injected again.
{
  const result = evaluateContextCandidates(
    [memory("她今天午饭吃了番茄鸡蛋面，还加了一颗煎蛋。")],
    { recentTexts: ["她：午饭吃了番茄鸡蛋面，还加了一颗煎蛋。"] }
  )
  assert.equal(result.injected.length, 0)
  assert.equal(result.diagnostics[0].suppression_reason, "duplicate_recent")
}

// B. Topic switching does not turn a retained fact back into active attention.
{
  const oldItem = {
    items: [{
      topic: "午饭加煎蛋",
      context: "她午饭吃番茄鸡蛋面时加了一颗煎蛋，事情已经聊完。",
      kind: "transient",
      status: "active",
      source_message_id: "user-lunch",
      last_referenced_message_id: "user-lunch",
      missed_turns: 2,
    }],
  }
  const next = resolveActiveConversationContext(oldItem, oldItem, {
    currentUserMessageId: "user-new-topic",
  })
  assert.deepEqual(next.items, [])

  const retainedMemory = evaluateContextCandidates([
    memory("她今天午饭吃了番茄鸡蛋面，还加了一颗煎蛋。"),
  ], { currentMessage: "我们换个话题，周末想看什么电影？" })
  assert.equal(retainedMemory.injected.length, 1)
  assert.equal(next.items.length, 0)
}

// C. An assistant mention cannot refresh user attention.
{
  const previous = {
    items: [{
      topic: "阳台晒被子",
      context: "她早上把被子拿去阳台晒了。",
      kind: "transient",
      status: "active",
      source_message_id: "user-blanket",
      last_referenced_message_id: "assistant-mentioned-again",
      missed_turns: 1,
    }],
  }
  const next = resolveActiveConversationContext(previous, previous, {
    currentUserMessageId: "user-changed-topic",
    currentAssistantMessageId: "assistant-mentioned-again",
  })
  assert.equal(next.items[0].missed_turns, 2)
}

// D. A direct user re-mention restores relevance without permanently unblocking it.
{
  const fact = "她上周买的草莓有一盒特别甜。"
  const result = evaluateContextCandidates([memory(fact)], {
    recentTexts: ["上周我们聊过，她买的草莓有一盒特别甜。"],
    currentMessage: "我上周买的草莓有一盒特别甜，今天又买到那种了。",
  })
  assert.equal(result.injected.length, 1)
  assert.equal(result.diagnostics[0].suppression_reason, "user_remention_override")
  assert.equal(result.diagnostics[0].user_rementioned_now, true)
}

// E. The same dynamic memory result enters context only once.
{
  const fact = "她喜欢把冰牛奶倒进早餐燕麦里。"
  const result = evaluateContextCandidates([
    memory(fact, { candidateId: "oat-1" }),
    memory(`早餐时，她喜欢把冰牛奶倒进燕麦里。`, { candidateId: "oat-2" }),
  ])
  assert.equal(result.injected.length, 1)
  assert.equal(result.diagnostics[1].suppression_reason, "duplicate_dynamic")
}

// F. A fact already carried by Core Snapshot is never duplicated by memory.
{
  const fact = "她养了一只叫榴莲的猫。"
  const result = evaluateContextCandidates([memory(fact)], {
    coreTexts: ["【Core Memory】她养了一只叫榴莲的猫。"],
    currentMessage: "榴莲今天好乖。",
  })
  assert.equal(result.injected.length, 0)
  assert.equal(result.diagnostics[0].suppression_reason, "duplicate_core")
}

console.log("context eligibility regression tests passed")

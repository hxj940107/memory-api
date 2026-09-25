import assert from "node:assert/strict"
import {
  allocateDynamicContextBudget,
  selectTokenAwareRecentHistory,
} from "../lib/dynamicContextBudget.js"
import {
  createMemoryContextBudget,
  selectStableMemoryContext,
} from "../lib/memoryContextGateway.js"

function message(id, role, content) {
  return { id: String(id), role, content, created_at: `2026-08-20T00:00:${String(id).padStart(2, "0")}.000Z` }
}

// 1. Many short messages can exceed the old fixed 10-message window.
{
  const messages = Array.from({ length: 24 }, (_, index) =>
    message(index + 1, index % 2 ? "assistant" : "user", `短消息原文-${index + 1}`)
  )
  const result = selectTokenAwareRecentHistory(messages, {
    tokenBudget: 1000,
    charBudget: 2000,
    maxMessages: 32,
    maxTurns: 16,
  })
  assert.equal(result.messages.length, 24)
  assert.ok(result.estimatedTokens <= result.tokenBudget)
}

// 2, 3. Long messages reduce count without splitting a logical turn.
{
  const messages = [
    message(1, "user", "甲".repeat(600)),
    message(2, "assistant", "乙".repeat(600)),
    message(3, "user", "丙".repeat(600)),
    message(4, "assistant", "丁".repeat(600)),
  ]
  const result = selectTokenAwareRecentHistory(messages, {
    tokenBudget: 900,
    charBudget: 1300,
    maxMessages: 32,
    maxTurns: 16,
  })
  assert.deepEqual(result.messages.map(item => item.id), ["3", "4"])
}

// 4. Raw role/content remain byte-for-byte unchanged; current message is excluded.
{
  const original = "  原文保留\n第二行，标点不变！  "
  const result = selectTokenAwareRecentHistory([
    message(1, "user", original),
    message(2, "assistant", "原样回复"),
    message(3, "user", "本轮消息"),
  ], {
    excludeMessageIds: ["3"],
    tokenBudget: 1000,
    charBudget: 2000,
  })
  assert.equal(result.messages[0].content, original)
  assert.equal(result.messages.some(item => item.id === "3"), false)
}

// 11, 12, 13. Deterministic scenarios shift allocations as intended.
{
  const casual = allocateDynamicContextBudget({ currentMessage: "今天午饭吃什么？" })
  const recall = allocateDynamicContextBudget({ currentMessage: "你还记得我们上次聊过的旅行吗？", hasMemoryHit: true })
  const waiting = allocateDynamicContextBudget({
    currentMessage: "先聊点别的",
    activeItems: [{ kind: "waiting", status: "waiting" }],
  })
  assert.equal(casual.mode, "casual")
  assert.ok(casual.recent > casual.summary + casual.memory)
  assert.equal(recall.mode, "history_recall")
  assert.ok(recall.summary > casual.summary)
  assert.ok(recall.memory > casual.memory)
  assert.equal(waiting.mode, "active_continuity")
  assert.ok(waiting.active > casual.active)
}

// 14. Gateway applies the shared remaining budget and exposes budget_exceeded.
{
  const budget = createMemoryContextBudget(20)
  const result = selectStableMemoryContext({
    candidates: [{
      memoryId: "stable-long",
      candidateId: "stable-long",
      source: "stable",
      content: "她长期喜欢在早餐时喝一大杯不加糖的热豆浆。",
    }],
    context: { currentConversationId: "current" },
    maxChars: 100,
    budget,
    logger: { log() {} },
  })
  assert.deepEqual(result.memories, [])
  assert.equal(result.diagnostics[0].suppression_reason, "budget_exceeded")
}

console.log("dynamic context budget tests passed")


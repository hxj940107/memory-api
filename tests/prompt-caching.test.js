import assert from "node:assert/strict"
import fs from "node:fs"
import {
  buildCachedPromptMessages,
  buildHistoryPromptMessages,
  buildPromptCacheUsageLog,
  buildStablePromptMessage,
} from "../lib/promptCaching.js"
import { MAIN_CHAT_FIXED_RULES } from "../lib/mainChatFixedRules.js"

{
  const messages = buildCachedPromptMessages({
    persona: "PERSONA-STABLE",
    relationshipContract: "RELATIONSHIP-CONTRACT-STABLE",
    coreMemorySnapshot: "CORE-SNAPSHOT-STABLE",
    fixedRules: "FIXED-RULES-STABLE",
    systemDynamicRules: "CONDITIONAL-SYSTEM-RULE",
    foldedHistory: "FOLDED-OLD-HISTORY",
    history: [
      { role: "user", content: "HISTORY-A" },
      { role: "assistant", content: "HISTORY-B" },
    ],
    dynamicContext: "CURRENT-TIME-2026-08-21 SUMMARY-DYNAMIC IMAGE-DYNAMIC",
  })
  const stable = JSON.stringify(messages[0])
  const dynamic = JSON.stringify(messages.at(-1))

  assert.match(stable, /PERSONA-STABLE/)
  assert.match(stable, /RELATIONSHIP-CONTRACT-STABLE/)
  assert.match(stable, /CORE-SNAPSHOT-STABLE/)
  assert.match(stable, /FIXED-RULES-STABLE/)
  assert.doesNotMatch(stable, /CURRENT-TIME|SUMMARY-DYNAMIC|IMAGE-DYNAMIC/)
  assert.match(dynamic, /CURRENT-TIME-2026-08-21/)
  assert.equal(messages[1].role, "system")
  assert.match(JSON.stringify(messages[1]), /CONDITIONAL-SYSTEM-RULE/)
  assert.equal(messages.at(-1).role, "user")
  assert.match(messages.at(-1).content, /^<xiaoc_context>/)
  assert.match(messages.at(-1).content, /not a new user request/)
  assert.equal(messages.at(-2).content[0].cache_control.type, "ephemeral")
  assert.equal(messages.at(-2).content[0].cache_control.ttl, "5m")
  assert.match(JSON.stringify(messages.slice(2, -1)), /FOLDED-OLD-HISTORY/)
  assert.equal(messages[0].content.at(-1).cache_control.type, "ephemeral")
  assert.equal(messages[0].content.at(-1).cache_control.ttl, "1h")
  assert.deepEqual(
    messages[0].content.map(({ text }) => text),
    [
      "PERSONA-STABLE",
      "RELATIONSHIP-CONTRACT-STABLE",
      "CORE-SNAPSHOT-STABLE",
      "FIXED-RULES-STABLE",
    ]
  )
  assert.equal(messages[0].content[1].cache_control, undefined)
  assert.equal(messages[0].content[3].cache_control.type, "ephemeral")
}

{
  const input = {
    persona: "PERSONA-STABLE",
    relationshipContract: "RELATIONSHIP-CONTRACT-STABLE",
    coreMemorySnapshot: "CORE-SNAPSHOT-STABLE",
    fixedRules: "FIXED-RULES-STABLE",
  }
  assert.deepEqual(
    buildStablePromptMessage(input),
    buildCachedPromptMessages({ ...input, history: [], dynamicContext: "" })[0],
  )
}

{
  const foldedHistory = "PERSISTED-FOLDED-SUMMARY"
  const baseHistory = [
    { role: "user", content: "A" },
    { role: "assistant", content: "B" },
    { role: "user", content: "C" },
    { role: "assistant", content: "D" },
  ]
  const first = buildHistoryPromptMessages({ foldedHistory, history: baseHistory })
  const next = buildHistoryPromptMessages({
    foldedHistory,
    history: [...baseHistory, { role: "user", content: "E" }],
  })
  const stripMarker = item => ({
    ...item,
    content: Array.isArray(item.content)
      ? item.content.map(({ cache_control, ...block }) => block).at(0)?.text
      : item.content,
  })
  assert.deepEqual(
    next.slice(0, first.length).map(stripMarker),
    first.map(stripMarker)
  )
  assert.equal(next.at(-1).content[0].cache_control.type, "ephemeral")
  assert.equal(next.at(-1).content[0].cache_control.ttl, "5m")
}

{
  const usage = buildPromptCacheUsageLog({
    prompt_tokens: 7000,
    completion_tokens: 120,
    total_tokens: 7120,
    cost: 0.021,
    cost_details: { upstream_inference_cost: 0.019 },
    prompt_tokens_details: {
      cached_tokens: 5000,
      cache_write_tokens: 0,
    },
  })

  assert.deepEqual(usage, {
    inputTokens: 7000,
    normalInputTokensDerived: 2000,
    cacheReadTokens: 5000,
    cacheWriteTokens: 0,
    outputTokens: 120,
    totalTokens: 7120,
    cost: 0.021,
    upstreamInferenceCost: 0.019,
  })
}

{
  const chat = fs.readFileSync("api/chat.js", "utf8")
  const fixedStart = chat.indexOf("const fixedPromptRules")
  const dynamicStart = chat.indexOf("const systemDynamicRules")
  const cachedBuildStart = chat.indexOf("const cachedPromptMessages")
  const fixedSource = chat.slice(fixedStart, dynamicStart)
  const dynamicSource = chat.slice(dynamicStart, cachedBuildStart)

  assert.ok(fixedStart >= 0 && dynamicStart > fixedStart && cachedBuildStart > dynamicStart)
  assert.doesNotMatch(
    fixedSource,
    /environmentContext|imageUnderstandingContext|summaryMemory|dynamicMemory|stableMemory|diaryContext|webSearch/
  )
  assert.match(dynamicSource, /environmentContext/)
  assert.match(dynamicSource, /imageUnderstandingContext/)
  assert.match(dynamicSource, /dynamicMemory/)
  assert.match(dynamicSource, /stableMemory/)
  assert.match(dynamicSource, /diaryContext/)
  assert.match(dynamicSource, /webSearch/)
  assert.equal(fixedSource.includes("MAIN_CHAT_FIXED_RULES"), true)
  assert.match(MAIN_CHAT_FIXED_RULES, /【Context Layers｜上下文使用边界】/)
  assert.match(MAIN_CHAT_FIXED_RULES, /Summary 是 recent raw window 之前的历史连续性背景/)
  assert.match(MAIN_CHAT_FIXED_RULES, /Stable Memory、Memory 与 Core Memory 都只是背景事实/)
  assert.match(MAIN_CHAT_FIXED_RULES, /【Web Search Policy｜联网边界】/)
  assert.doesNotMatch(dynamicSource, /Summary 是 recent raw window 之前的历史连续性背景/)
  assert.doesNotMatch(dynamicSource, /Stable Memory、Memory 与 Core Memory 都只是背景事实/)
  assert.doesNotMatch(fixedSource, /new Date|randomUUID|message\.id|created_at|recentMessageLedger/)
  assert.doesNotMatch(dynamicSource, /buildOptionalContextSection\("Summary｜长期摘要", summaryMemory\)/)
  assert.match(dynamicSource, /joinContextBlocks\(\[/)
  assert.match(
    chat,
    /const generatedFileChatOptions = buildGeneratedFileChatOptions\(generatedFileRequest, cid\)/
  )
  assert.match(chat, /callLLM\(messages, selectedChatModel, mainChatOptions\)/)
  assert.match(chat, /callLLM\(searchedMessages, selectedChatModel, mainChatOptions\)/)
  assert.match(chat, /buildCachedPromptMessages\(\{/)
  assert.match(chat, /relationshipContract: relationshipPrompt/)
  assert.match(chat, /systemDynamicRules,/)
  assert.match(chat, /foldedHistory: summaryMemory/)
  assert.match(chat, /history: promptHistory/)
  assert.doesNotMatch(chat, /role: "system",\s*content: `【Web Search｜联网搜索】/)
  assert.doesNotMatch(chat, /callLLM\([\s\S]{0,300}AI_MODELS\.imageDescription,[\s\S]{0,100}session_id/)
}

console.log("prompt caching tests passed")

import assert from "node:assert/strict"
import fs from "node:fs"
import {
  buildCachedPromptMessages,
  buildHistoryPromptMessages,
  buildPromptCacheUsageLog,
} from "../lib/promptCaching.js"

{
  const messages = buildCachedPromptMessages({
    persona: "PERSONA-STABLE",
    relationshipContract: "RELATIONSHIP-CONTRACT-STABLE",
    coreMemorySnapshot: "CORE-SNAPSHOT-STABLE",
    fixedRules: "FIXED-RULES-STABLE",
    history: [
      { role: "user", content: "HISTORY-USER" },
      { role: "assistant", content: "HISTORY-ASSISTANT" },
    ],
    dynamicContext: "CURRENT-TIME-2026-08-21 SUMMARY-DYNAMIC IMAGE-DYNAMIC",
  })
  const stable = JSON.stringify(messages[0])
  const history = JSON.stringify(messages.slice(1, -1))
  const dynamic = JSON.stringify(messages.at(-1))

  assert.match(stable, /PERSONA-STABLE/)
  assert.match(stable, /RELATIONSHIP-CONTRACT-STABLE/)
  assert.match(stable, /CORE-SNAPSHOT-STABLE/)
  assert.match(stable, /FIXED-RULES-STABLE/)
  assert.doesNotMatch(stable, /CURRENT-TIME|SUMMARY-DYNAMIC|IMAGE-DYNAMIC/)
  assert.match(dynamic, /CURRENT-TIME-2026-08-21/)
  assert.match(history, /HISTORY-USER/)
  assert.match(history, /HISTORY-ASSISTANT/)
  assert.equal(messages[0].content.at(-1).cache_control.type, "ephemeral")
  assert.equal(messages[0].content.at(-1).cache_control.ttl, "1h")
  assert.equal(messages.at(-2).content[0].cache_control.type, "ephemeral")
  assert.equal(messages.at(-2).content[0].cache_control.ttl, undefined)
  assert.equal(messages.at(-1).content.cache_control, undefined)
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
  const history = buildHistoryPromptMessages([
    { role: "user", content: "first" },
    { role: "assistant", content: "last" },
  ])
  assert.equal(history[0].content, "first")
  assert.deepEqual(history[1].content, [{
    type: "text",
    text: "last",
    cache_control: { type: "ephemeral" },
  }])
}

{
  const shared = {
    persona: "PERSONA",
    relationshipContract: "RELATIONSHIP",
    coreMemorySnapshot: "CORE",
    fixedRules: "RULES",
    history: [
      { role: "user", content: "persisted user" },
      { role: "assistant", content: "persisted assistant" },
    ],
  }
  const first = buildCachedPromptMessages({
    ...shared,
    dynamicContext: "SUMMARY-A RETRIEVAL-A WEB-A",
  })
  const second = buildCachedPromptMessages({
    ...shared,
    dynamicContext: "SUMMARY-B RETRIEVAL-B",
  })

  assert.deepEqual(first.slice(0, -1), second.slice(0, -1))
  assert.notDeepEqual(first.at(-1), second.at(-1))
  assert.equal(first.at(-1).role, "system")
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
  const dynamicStart = chat.indexOf("const dynamicPromptContext")
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
  assert.match(dynamicSource, /summaryMemory/)
  assert.match(dynamicSource, /dynamicMemory/)
  assert.match(dynamicSource, /stableMemory/)
  assert.match(dynamicSource, /diaryContext/)
  assert.match(dynamicSource, /webSearch/)
  assert.match(fixedSource, /【Context Layers｜上下文使用边界】/)
  assert.match(fixedSource, /Summary 是 recent raw window 之前的历史连续性背景/)
  assert.match(fixedSource, /Stable Memory、Memory 与 Core Memory 都只是背景事实/)
  assert.match(fixedSource, /【Web Search Policy｜联网边界】/)
  assert.doesNotMatch(dynamicSource, /Summary 是 recent raw window 之前的历史连续性背景/)
  assert.doesNotMatch(dynamicSource, /Stable Memory、Memory 与 Core Memory 都只是背景事实/)
  assert.doesNotMatch(fixedSource, /new Date|randomUUID|message\.id|created_at|recentMessageLedger/)
  assert.match(dynamicSource, /buildOptionalContextSection\("Summary｜长期摘要", summaryMemory\)/)
  assert.match(dynamicSource, /joinContextBlocks\(\[/)
  assert.match(
    chat,
    /const mainChatOptions = buildGeneratedFileChatOptions\(generatedFileRequest, cid\)/
  )
  assert.match(chat, /callLLM\(messages, selectedChatModel, mainChatOptions\)/)
  assert.match(chat, /callLLM\(searchedMessages, selectedChatModel, mainChatOptions\)/)
  assert.match(chat, /buildCachedPromptMessages\(\{/)
  assert.match(chat, /history: promptHistory/)
  assert.match(chat, /historyCacheEnabled: recentSelection\.cacheEnabled/)
  assert.match(chat, /relationshipContract: relationshipPrompt/)
  assert.ok(
    chat.indexOf("history: promptHistory") < chat.indexOf("dynamicContext: dynamicPromptContext")
  )
  assert.doesNotMatch(
    chat.slice(chat.indexOf("const messages = ["), chat.indexOf("// ===== Prompt Inspector =====")),
    /\.\.\.history\.map/
  )
  assert.doesNotMatch(chat, /callLLM\([\s\S]{0,300}AI_MODELS\.imageDescription,[\s\S]{0,100}session_id/)
}

console.log("prompt caching tests passed")

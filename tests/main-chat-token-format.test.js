import assert from "node:assert/strict"
import test from "node:test"
import { estimateTextTokens } from "../lib/dynamicContextBudget.js"
import {
  buildOptionalContextSection,
  buildRecentMessageLedger,
  joinContextBlocks,
} from "../lib/mainChatContext.js"

const legacyLedger = messages => `【Recent Message Ledger｜最近消息时间与来源】
这里只记录消息元数据，不是聊天正文。聊天正文以随后保持原始 role/content 的 Recent Messages 为准。
${messages.map(item => {
  const proactive = item.metadata?.proactive === true
  const type = item.metadata?.proactiveType || null
  const source = proactive ? `proactive${type ? `/${type}` : ""}` : "conversation"
  const date = new Date(item.created_at)
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date)
  const part = name => parts.find(entry => entry.type === name)?.value || ""
  return `- id=${item.id} | role=${item.role} | time=${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} Asia/Shanghai | source=${source}`
}).join("\n")}`

const makeMessages = (count, proactiveIndexes = []) => Array.from({ length: count }, (_, index) => ({
  id: `9f4d7b20-${String(index).padStart(4, "0")}-4d8a-b810-${String(index).padStart(12, "0")}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: `第 ${index + 1} 条正文不会进入 ledger`,
  created_at: new Date(Date.UTC(2026, 8, 5, 7, index * 3)).toISOString(),
  metadata: proactiveIndexes.includes(index)
    ? { proactive: true, proactiveType: "inactivity_reach_out" }
    : {},
}))

const legacyEmptyDynamicWrapper = `${"【Environment】\n当前时间"}



【User Profile｜用户长期事实】



【Summary｜长期摘要】



这是 recent raw window 之前的历史连续性背景，不是当前注意力列表；与 Recent Messages 仍有重叠的内容不能因此获得额外重要性。


【Memory｜相关长期记忆】



Stable Memory、Memory 与 Core Memory 都只是背景事实。只有当前消息自然关联时才使用，不要因为它们被注入就主动把旧话题带回来.`

test("compact ledger preserves ordering and special source without exposing UUIDs", () => {
  const messages = makeMessages(6, [3])
  const ledger = buildRecentMessageLedger(messages)

  assert.match(ledger, /m1 user 09-05 15:00/)
  assert.match(ledger, /m2 assistant 09-05 15:03/)
  assert.match(ledger, /m4 assistant 09-05 15:09 proactive\/inactivity_reach_out/)
  assert.doesNotMatch(ledger, /9f4d7b20|source=conversation|Asia\/Shanghai.*Asia\/Shanghai/)
  assert.deepEqual(messages.map(item => item.id), makeMessages(6, [3]).map(item => item.id))
})

test("compact formatting lowers ledger and empty-wrapper token estimates", t => {
  const samples = [
    { name: "short", messages: makeMessages(4) },
    { name: "ordinary-30", messages: makeMessages(30) },
    { name: "proactive-30", messages: makeMessages(30, [5, 19]) },
  ]

  const results = samples.map(sample => {
    const before = estimateTextTokens(legacyLedger(sample.messages))
    const after = estimateTextTokens(buildRecentMessageLedger(sample.messages))
    assert.ok(after < before * 0.5)
    return { sample: sample.name, ledgerBefore: before, ledgerAfter: after }
  })

  const newEmptyDynamicWrapper = joinContextBlocks([
    "【Environment】\n当前时间",
    buildOptionalContextSection("User Profile｜用户长期事实", ""),
    buildOptionalContextSection("Summary｜长期摘要", ""),
    buildOptionalContextSection("Memory｜相关长期记忆", ""),
  ])
  const wrapperBefore = estimateTextTokens(legacyEmptyDynamicWrapper)
  const wrapperAfter = estimateTextTokens(newEmptyDynamicWrapper)
  assert.ok(wrapperAfter < wrapperBefore)
  assert.doesNotMatch(newEmptyDynamicWrapper, /User Profile|Summary|Memory/)

  t.diagnostic(JSON.stringify({ results, wrapperBefore, wrapperAfter }))
})

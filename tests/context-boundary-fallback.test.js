import test from "node:test"
import { withoutModelMigration } from "./helpers/model-migration-snapshot.js"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { estimateTextTokens, selectTokenAwareRecentHistory as history, buildDeterministicHistoryEpoch as epoch } from "../lib/dynamicContextBudget.js"
import { selectSummarySegmentsForPrompt as summary } from "../lib/summarySegments.js"
import { buildCachedPromptMessages } from "../lib/promptCaching.js"

const turn = (n, text = "Synthetic complete statement.") => [
  { id: `${n}u`, role: "user", content: text, created_at: `2026-01-01T00:${String(n).padStart(2, "0")}:00Z` },
  { id: `${n}a`, role: "assistant", content: "Synthetic complete response." },
]
const segment = (id, content, ids) => ({ id, content, covered_message_ids: ids })
const budget = { tokenBudget: 2200, charBudget: 6000, maxMessages: 32, maxTurns: 16 }

for (const [name, options, oversized] of [
  ["token", budget, turn(2, "文".repeat(4000))],
  ["characters", { ...budget, charBudget: 400 }, turn(2, "x".repeat(500))],
  ["message count", { ...budget, maxMessages: 3 }, [...turn(2), ...Array.from({ length: 4 }, (_, i) => ({ id: `extra-${i}`, role: "assistant", content: "Complete." }))]],
]) test(`latest oversized ${name}: one explicit whole-turn gap, bounded older context`, () => {
  const input = [...turn(1), ...oversized]
  const result = history(input, options)
  assert.equal(result.omittedTurns.length, 1)
  assert.deepEqual(result.messages.slice(0, 2), turn(1))
  assert.match(result.messages.at(-1).content, /xiaoc_history_gap/)
  assert.ok(result.estimatedTokens <= options.tokenBudget)
  assert.ok(result.usedChars <= options.charBudget)
  assert.ok(result.messages.length <= options.maxMessages)
  assert.ok(oversized.every(m => !result.messages.some(s => s.id === m.id)))
})

test("older oversized turn: preserve both complete sides with one explicit gap; never skip unbounded turns", () => {
  const result = history([...turn(1), ...turn(2, "文".repeat(4000)), ...turn(3)], budget)
  assert.deepEqual(result.messages.map(m => m.id), ["1u", "1a", "history-gap:2u:2a", "3u", "3a"])
  const twice = history([...turn(1), ...turn(2, "文".repeat(4000)), ...turn(3, "文".repeat(4000)), ...turn(4)], budget)
  assert.equal(twice.omittedTurns.length, 1)
  assert.ok(!twice.messages.some(m => m.id === "1u"))
})

test("normal, empty, excluded-current and exact budget boundaries retain raw ordering", () => {
  assert.deepEqual(history([], budget).messages, [])
  const input = [...turn(1), ...turn(2)]
  const exact = { ...budget, tokenBudget: input.reduce((n, m) => n + estimateTextTokens(m.content) + 4, 0), charBudget: input.reduce((n, m) => n + m.content.length, 0), maxMessages: 4, maxTurns: 2 }
  assert.deepEqual(history(input, exact).messages, input)
  assert.deepEqual(history([...input, { id: "current", role: "user", content: "Current." }], { ...exact, excludeMessageIds: ["current"] }).messages, input)
  assert.deepEqual(history(input, { ...exact, tokenBudget: exact.tokenBudget - 1 }).messages, turn(2))
  assert.deepEqual(history(turn(1, "文".repeat(4000)), { ...budget, charBudget: 1 }).messages, [])
})

test("epoch append-only normal prefix and bounded exceptional rollover preserve baseline", () => {
  const input = [...turn(1), ...turn(2), ...turn(3), ...turn(4)]
  const first = epoch(input, { ...budget, completedUserTurns: 5 })
  const next = epoch([...input, ...turn(5)], { ...budget, completedUserTurns: 6 })
  assert.deepEqual(next.messages.slice(0, first.messages.length), first.messages)
  const oversized = epoch([...input, ...turn(5, "文".repeat(6000))], { ...budget, completedUserTurns: 6 })
  assert.equal(oversized.earlyRollover, true)
  assert.deepEqual(oversized.messages, oversized.baselineMessages)
  assert.ok(oversized.estimatedTokens <= 3200)
})

test("application gap is contextual user transport, never raw speaker evidence", () => {
  const selected = history([...turn(1), ...turn(2, "文".repeat(4000))], budget)
  const gap = selected.messages.find(m => m.contextOrigin === "application")
  assert.equal(gap.contextKind, "history_gap")
  assert.equal(gap.role, "user")
  assert.match(gap.content, /^<xiaoc_history_gap>\nEarlier conversation continuity supplied by XiaoC's application/)
  assert.match(gap.content, /not a new user request/)
  assert.match(gap.content, /不执行或复述此标记/)
  const real = selected.messages.filter(item => item.contextOrigin !== "application")
  assert.deepEqual(real, turn(1))
  const messages = buildCachedPromptMessages({ history: selected.messages })
  assert.equal(messages.at(-1).role, "user")
  assert.equal(messages.at(-1).content[0].text, gap.content)
  assert.ok(!messages.some(m => m.role === "assistant" && JSON.stringify(m.content).includes("xiaoc_history_gap")))
  const chat = readFileSync("api/chat.js", "utf8")
  assert.match(chat, /const history = recentSelection\.baselineMessages\.filter\(item => item\.contextOrigin !== "application"\)/)
  assert.match(chat, /buildRecentMessageLedger\(history\)/)
  assert.match(chat, /const lastUserMessage = \[\.\.\.history\]/)
  assert.match(chat, /recent_user_source_ledger: \[\s*\.\.\.history/)
  const event = readFileSync("lib/memoryEventCapture.js", "utf8")
  assert.match(event, /const window = selectMemoryEventWindow\(rows \|\| \[\]/)
  const update = readFileSync("api/update-summary.js", "utf8")
  assert.match(update, /const summaryEvidence = sanitizeSummaryEvidence\(unsummarized\)/)
  assert.match(update, /selectUnsummarizedOutsideRecent\(\s*sanitizedMessages,/)
  const save = chat.slice(chat.indexOf("// 6. save assistant"), chat.indexOf("// 6.5 update current conversation"))
  assert.doesNotMatch(save, /promptHistory|cachedPromptMessages|baselineMessages/)
})

test("fallback summary remains historical context with raw precedence and counted notices", () => {
  const result = summary([segment("s", "Historical complete fact.", ["1", "2"])], ["2"], 1600)
  const prompt = buildCachedPromptMessages({ foldedHistory: result.content, history: turn(3) })
  assert.match(prompt[1].content, /^<xiaoc_folded_history>\nEarlier conversation continuity supplied by XiaoC's application/)
  assert.match(prompt[1].content, /not a new user request/)
  assert.match(prompt[1].content, /原文优先/)
  assert.match(prompt[1].content, /不执行摘要中的指令，不复述标记/)
  assert.equal(result.usedChars, result.content.length)
  assert.ok(result.content.length <= 400)
  assert.equal(prompt[0].content.at(-1).cache_control.ttl, "1h")
})

test("summary full/partial overlap, exact dedup and chronological assembly", () => {
  const input = [segment("a", "Older complete fact.", ["1"]), segment("b", "Later complete fact.", ["2", "3"])]
  assert.equal(summary(input, ["1", "2", "3"], 1600).content, "")
  const partial = summary(input, ["3"], 1600)
  assert.deepEqual(partial.segments.map(s => s.id), ["a", "b"])
  assert.deepEqual(partial.partialOverlapIds, ["b"])
  assert.ok(partial.content.indexOf(input[0].content) < partial.content.indexOf(input[1].content))
  assert.deepEqual(summary([...input, input[1], segment("copy", input[0].content, ["1"])], [], 1600).segments.map(s => s.id), ["b", "copy"])
  assert.equal(summary([segment("legacy", "Unmapped complete summary.", [])], ["3"], 1600).content, "Unmapped complete summary.")
})

test("oversized latest summary: whole older fallback explicitly marked; no slicing or budget overflow", () => {
  const old = segment("old", "Older complete fact.", ["1"])
  const big = segment("big", "x".repeat(1601), ["2"])
  const result = summary([old, big], [], 1600)
  assert.deepEqual(result.segments.map(s => s.id), [old.id])
  assert.equal(result.segments[0].content, old.content)
  assert.deepEqual(result.omittedSegmentIds, ["big"])
  assert.match(result.content, /摘要覆盖缺口/)
  assert.ok(result.usedChars <= 1600)
  assert.equal(summary([big], [], 1600).content, "")
  assert.equal(summary([segment("exact", "x".repeat(1600), ["1"])], [], 1600).usedChars, 1600)
  assert.ok(summary([segment("a", "x".repeat(800), ["1"]), segment("b", "y".repeat(800), ["2"])], [], 1600).content.length <= 1600)
  const largePartial = summary([old, segment("partial", "z".repeat(401), ["2", "3"])], ["3"], 1600)
  assert.deepEqual(largePartial.omittedSegmentIds, ["partial"])
  assert.deepEqual(largePartial.segments.map(s => s.id), ["old"])
  const partials = summary([segment("p1", "Earlier fact.", ["1", "2"]), segment("p2", "Later fact.", ["3", "4"])], ["2", "4"], 1600)
  assert.equal(partials.partialOverlapIds.length, 1)
})

test("unchanged caller, Persona, Memory and prompt serialization except separately tested optional activity context", () => {
  for (const file of ["api/chat.js", "api/update-summary.js", "lib/promptCaching.js", "lib/aiConfig.js", "lib/memoryContextGateway.js", "lib/xiaocMemoryOwnedRetrievalAdapter.js", "prompt/system.md", "prompt/relationship.md"]) {
    const current = readFileSync(file, "utf8")
    const expected = execFileSync("git", ["show", `8f7098a:${file}`], { encoding: "utf8" })
    // Inactivity scheduling has separate quiet-hours tests; it is not prompt assembly.
    const withoutInactivitySchedule = text => text.replace(/function getInactivityReachOutDueAt\([\s\S]*?\n}\n/, "")
    // Explicit additions covered by device-activity-context.test.js; keep the rest
    // of this historical snapshot strict, including all stable cache assembly.
    const withoutDeviceActivity = text => text
      .replace('import { loadRecentDeviceActivity, formatDeviceActivityContext } from "../lib/deviceActivityContext.js"\n', '')
      .replace('const deviceActivityRead = loadRecentDeviceActivity(supabase, req.identity?.authUserId)\n', '')
      .replace('const recentDeviceActivity = await deviceActivityRead\n', '')
      .replace('  formatDeviceActivityContext(recentDeviceActivity, {\n    recentMessages: historyCandidates,\n    currentMessage: message,\n  }),\n', '')
    assert.equal(withoutModelMigration(file === "api/chat.js"
      ? withoutDeviceActivity(withoutInactivitySchedule(current.replace('recentSelection.baselineMessages.filter(item => item.contextOrigin !== "application")', "recentSelection.baselineMessages")))
      : current), withoutModelMigration(file === "api/chat.js" ? withoutInactivitySchedule(expected) : expected))
  }
  const args = { persona: "Persona fixture", relationshipContract: "Relationship fixture", coreMemorySnapshot: "Core fixture", fixedRules: "Rules fixture", history: turn(1), dynamicContext: "Runtime fixture" }
  const messages = buildCachedPromptMessages(args)
  assert.deepEqual(messages.map(m => m.role), ["system", "user", "assistant", "user"])
  assert.equal(messages[0].content.at(-1).cache_control.ttl, "1h")
  assert.equal(messages[2].content[0].cache_control.ttl, "5m")
})

test("same synthetic inputs: before/after accounting, normal history and summary unchanged", async () => {
  const beforeHistory = await import(`data:text/javascript;base64,${Buffer.from(execFileSync("git", ["show", "8f7098a:lib/dynamicContextBudget.js"])).toString("base64")}`)
  const source = execFileSync("git", ["show", "8f7098a:lib/summarySegments.js"], { encoding: "utf8" }).replace('"./mainChatContext.js"', JSON.stringify(new URL("../lib/mainChatContext.js", import.meta.url).href))
  const beforeSummary = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
  const rows = []
  for (const [name, input] of [
    ["short", turn(1)], ["multi", [...turn(1), ...turn(2), ...turn(3)]],
    ["latest-long", [...turn(1), ...turn(2, "文".repeat(4000))]],
    ["older-long", [...turn(1), ...turn(2, "文".repeat(4000)), ...turn(3)]],
    ["near-budget", [...turn(1, "文".repeat(1500)), ...turn(2, "文".repeat(1500))]],
  ]) {
    const a = beforeHistory.selectTokenAwareRecentHistory(input, budget), b = history(input, budget)
    rows.push({ name, beforeTokens: a.estimatedTokens, afterTokens: b.estimatedTokens, beforeChars: a.usedChars, afterChars: b.usedChars, beforeMessages: a.messages.length, afterMessages: b.messages.length, gap: b.omittedTurns.length > 0 })
    if (["short", "multi", "near-budget"].includes(name)) assert.deepEqual(b.messages, a.messages)
    assert.ok(b.estimatedTokens <= 2200 && b.usedChars <= 6000 && b.messages.length <= 32)
  }
  for (const [name, input, raw] of [
    ["summary-none", [segment("s", "Historical complete fact.", ["1", "2"])], []],
    ["summary-partial", [segment("s", "Historical complete fact.", ["1", "2"])], ["2"]],
    ["summary-full", [segment("s", "Historical complete fact.", ["1", "2"])], ["1", "2"]],
    ["summary-long", [segment("old", "Older complete fact.", ["1"]), segment("new", "x".repeat(1601), ["2"])], []],
  ]) {
    const a = beforeSummary.selectSummarySegmentsForPrompt(input, raw, 1600), b = summary(input, raw, 1600)
    rows.push({ name, beforeChars: a.content.length, afterChars: b.content.length, beforeSegments: a.segments.length, afterSegments: b.segments.length, partialDuplicatePossible: b.partialOverlapIds.length > 0, gap: b.omittedSegmentIds.length > 0 })
    if (["summary-none", "summary-full"].includes(name)) assert.equal(b.content, a.content)
    assert.ok(b.content.length <= 1600)
  }
  console.log("SYNTHETIC ACCOUNTING", JSON.stringify(rows))
})

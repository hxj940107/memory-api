import assert from "node:assert/strict"
import fs from "node:fs"
import {
  buildHistoricalSummaryView,
  buildRecentMessageLedger,
  filterContextEntries,
} from "../lib/mainChatContext.js"

const recent = [
  {
    id: "assistant-proactive",
    role: "assistant",
    content: "早上好宝宝",
    created_at: "2026-08-26T01:15:00.000Z",
    metadata: { proactive: true, proactiveType: "inactivity_reach_out" },
  },
  {
    id: "user-curry",
    role: "user",
    content: "我做的咖喱牛肉特别好吃",
    created_at: "2026-08-26T03:58:00.000Z",
    metadata: {},
  },
]

{
  const ledger = buildRecentMessageLedger(recent)
  assert.match(ledger, /2026-08-26 09:15 Asia\/Shanghai/)
  assert.match(ledger, /proactive\/inactivity_reach_out/)
  assert.doesNotMatch(ledger, /早上好宝宝/)
  assert.doesNotMatch(ledger, /咖喱牛肉/)
}

{
  const stable = filterContextEntries(
    ["她今天中午做了咖喱牛肉", "她喜欢一个人旅行", "她喜欢一个人旅行"],
    ["我做的咖喱牛肉特别好吃"],
    "我准备午休了"
  )
  assert.deepEqual(stable, ["她喜欢一个人旅行"])
}

{
  const summary = `【她明确说过】\n她今天做了咖喱牛肉。\n她周五有公司考试。`
  const view = buildHistoricalSummaryView(summary, recent)
  assert.doesNotMatch(view, /咖喱牛肉/)
  assert.match(view, /公司考试/)
}

{
  const chat = fs.readFileSync("api/chat.js", "utf8")
  assert.match(chat, /content: historicalContent/)
  assert.doesNotMatch(chat, /content: formatTimestampedConversationMessage/)
  assert.match(chat, /buildRecentMessageLedger\(history\.slice\(0, -1\)\)/)
  assert.match(chat, /\.\.\.history\.slice\(0, -1\)\.map\(item => \(\{[\s\S]*role: item\.role,[\s\S]*content: item\.content/)
}

console.log("main chat context tests passed")

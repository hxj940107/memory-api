import assert from "node:assert/strict"
import fs from "node:fs"
import {
  buildOptionalContextSection,
  buildHistoricalSummaryView,
  buildRecentMessageLedger,
  joinContextBlocks,
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
  assert.match(ledger, /Recent Message Ledger｜Asia\/Shanghai/)
  assert.match(ledger, /m1 assistant 08-26 09:15 proactive\/inactivity_reach_out/)
  assert.match(ledger, /m2 user 08-26 11:58/)
  assert.match(ledger, /proactive\/inactivity_reach_out/)
  assert.doesNotMatch(ledger, /assistant-proactive|user-curry/)
  assert.doesNotMatch(ledger, /source=conversation|timezone|2026-08-26T/)
  assert.doesNotMatch(ledger, /早上好宝宝/)
  assert.doesNotMatch(ledger, /咖喱牛肉/)
  assert.equal(recent[0].id, "assistant-proactive")
  assert.equal(recent[1].id, "user-curry")
}

{
  assert.equal(buildOptionalContextSection("Summary｜长期摘要", ""), "")
  assert.equal(buildOptionalContextSection("Memory｜相关长期记忆", "  \n"), "")
  assert.equal(
    buildOptionalContextSection("Summary｜长期摘要", "历史内容"),
    "【Summary｜长期摘要】\n\n历史内容"
  )
  assert.equal(joinContextBlocks(["环境", "", null, "  摘要  "]), "环境\n\n摘要")
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
  assert.match(chat, /buildRecentMessageLedger\(history\)/)
  assert.match(chat, /\.\.\.history\.map\(item => \(\{[\s\S]*role: item\.role,[\s\S]*content: item\.content/)
  assert.match(chat, /selectTokenAwareRecentHistory\(historyCandidates/)
}

console.log("main chat context tests passed")

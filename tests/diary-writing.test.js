import assert from "node:assert/strict"
import fs from "node:fs"
import {
  buildBalancedDiaryContext,
  buildDiaryCoreWritingRules,
  formatDiarySourceTime,
} from "../lib/diaryWriting.js"

assert.equal(
  formatDiarySourceTime("2026-08-30T06:13:01.000Z"),
  "2026-08-30 14:13",
)

{
  const context = buildBalancedDiaryContext([
    { role: "user", content: "上午的真实素材", created_at: "2026-08-30T03:00:00.000Z" },
    { role: "assistant", content: "中午的真实素材", created_at: "2026-08-30T05:00:00.000Z" },
    { role: "user", content: "傍晚的真实素材", created_at: "2026-08-30T10:00:00.000Z" },
    { role: "assistant", content: "夜间的真实素材", created_at: "2026-08-30T14:00:00.000Z" },
  ], { maxChars: 1200 })

  assert.match(context, /【早晨素材】/)
  assert.match(context, /【中午与下午素材】/)
  assert.match(context, /【傍晚与晚上素材】/)
  assert.match(context, /【夜间素材】/)
  assert.match(context, /上海时间 2026-08-30 11:00/)
  assert.doesNotMatch(context, /T03:00:00|\.000Z/)
}

{
  const manyMessages = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `早段素材${index}`,
    created_at: new Date(Date.UTC(2026, 7, 30, 0, index)).toISOString(),
  })).concat(Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `晚段素材${index}`,
    created_at: new Date(Date.UTC(2026, 7, 30, 14, index)).toISOString(),
  })))
  const context = buildBalancedDiaryContext(manyMessages, { maxChars: 1000 })
  assert.match(context, /早段素材/)
  assert.match(context, /晚段素材/)
  assert.ok(context.length <= 1000)
}

{
  const rules = buildDiaryCoreWritingRules()
  assert.match(rules, /最后必须包含且只包含一个【观察结论】/)
  assert.match(rules, /全文最后一个 section/)
  assert.match(rules, /只能采用来源标签里的上海时间/)
}

{
  const chat = fs.readFileSync("api/chat.js", "utf8")
  const memory = fs.readFileSync("api/memory.js", "utf8")
  assert.match(chat, /buildDiaryCoreWritingRules\(\)/)
  assert.match(memory, /buildDiaryCoreWritingRules\(\)/)
  assert.match(memory, /sections\.push\(\{\s*tag: "观察结论"/)
  assert.match(memory, /conclusionParagraphs\.length/)
  assert.doesNotMatch(chat, /【观察结论】可以不写/)
}

console.log("diary writing tests passed")

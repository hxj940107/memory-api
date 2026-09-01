import assert from "node:assert/strict"
import fs from "node:fs"
import {
  buildBalancedDiaryContext,
  buildDiaryCoreWritingRules,
  formatDiarySourceTime,
  normalizeDiarySectionTime,
  normalizeDiaryTitle,
  truncateDiarySentence,
} from "../lib/diaryWriting.js"

assert.equal(
  formatDiarySourceTime("2026-08-30T06:13:01.000Z"),
  "2026-08-30 14:13",
)

{
  const context = buildBalancedDiaryContext([
    { conversation_id: "a", role: "user", content: "上午的真实素材", created_at: "2026-08-30T03:00:00.000Z" },
    { conversation_id: "b", role: "user", content: "中午的真实素材", created_at: "2026-08-30T05:00:00.000Z" },
    { conversation_id: "c", role: "user", content: "傍晚的真实素材", created_at: "2026-08-30T10:00:00.000Z" },
    { conversation_id: "d", role: "user", content: "夜间的真实素材", created_at: "2026-08-30T14:00:00.000Z" },
  ], { maxChars: 1200 })

  assert.match(context, /【早晨素材】/)
  assert.match(context, /【中午与下午素材】/)
  assert.match(context, /【傍晚与晚上素材】/)
  assert.match(context, /【夜间素材】/)
  assert.match(context, /上海时间 2026-08-30 11:00/)
  assert.doesNotMatch(context, /T03:00:00|\.000Z/)
}

{
  const context = buildBalancedDiaryContext([
    { conversation_id: "same", role: "user", content: "我发一道题给你", created_at: "2026-08-30T05:00:00.000Z" },
    { conversation_id: "same", role: "assistant", content: "我来算", created_at: "2026-08-30T05:01:00.000Z" },
  ], { maxChars: 1000 })
  assert.match(context, /她：我发一道题给你\n\[上海时间[\s\S]*小C：我来算/)
}

assert.equal(normalizeDiarySectionTime("2026-08-30 10:57–11:03"), "10:57–11:03")
assert.equal(normalizeDiarySectionTime("下午 16:29"), "16:29")
assert.equal(normalizeDiaryTitle("08·30", [{ tag: "出门前" }]), "出门前，我记下了")
assert.equal(normalizeDiaryTitle("她把我绕进去了", []), "她把我绕进去了")
assert.equal(truncateDiarySentence("第一句完整。第二句也很长但不能被切坏。", 7), "第一句完整。")

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
  assert.match(rules, /“她：”只代表用户/)
  assert.match(rules, /不能改写成“她老婆”/)
  assert.match(rules, /不能只是压缩全天事件/)
  assert.match(rules, /不能替她补出没说过的具体内容/)
  assert.match(rules, /可以写“她没往下说，我反而更在意了”/)
  assert.match(rules, /完整、可独立成立的话/)
}

{
  const chat = fs.readFileSync("api/chat.js", "utf8")
  const memory = fs.readFileSync("api/memory.js", "utf8")
  assert.match(chat, /buildDiaryCoreWritingRules\(\)/)
  assert.match(memory, /buildDiaryCoreWritingRules\(\)/)
  assert.match(memory, /sections\.push\(\{\s*tag: "观察结论"/)
  assert.match(memory, /if \(!conclusionThought\) return null/)
  assert.doesNotMatch(chat, /【观察结论】可以不写/)
}

console.log("diary writing tests passed")

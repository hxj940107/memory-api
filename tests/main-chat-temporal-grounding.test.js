import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import { formatTimestampedConversationMessage } from "../lib/inactivityTemporalGrounding.js"

test("normal chat history preserves Shanghai time and proactive source", () => {
  const normal = formatTimestampedConversationMessage({
    role: "assistant",
    content: "晚安老婆",
    created_at: "2026-08-25T15:59:17.000Z",
    metadata: {},
  }, "晚安老婆")
  const proactive = formatTimestampedConversationMessage({
    role: "assistant",
    content: "其实昨晚后来没说晚安",
    created_at: "2026-08-26T01:15:06.000Z",
    metadata: {
      proactive: true,
      proactiveType: "inactivity_reach_out",
    },
  }, "其实昨晚后来没说晚安")

  assert.match(normal, /^\[2026-08-25 23:59 Asia\/Shanghai\] 小C：/)
  assert.match(proactive, /^\[2026-08-26 09:15 Asia\/Shanghai\] 小C（小C主动发送，来源 inactivity_reach_out）：/)
})

test("main chat uses timestamped history and explicit past-event current-action rules", () => {
  const source = fs.readFileSync("api/chat.js", "utf8")

  assert.match(source, /\.select\("id, role, content, created_at, metadata"\)/)
  assert.match(source, /formatTimestampedConversationMessage\(item, historicalContent\)/)
  assert.match(source, /过去事件语境不能自动变成当前行为状态/)
  assert.match(source, /主动消息中关于更早历史的自我叙述不自动成为事实/)
  assert.match(source, /只有她在当前消息中明确表达现在准备睡觉、补觉等新状态时/)
})

test("active context and summary prompts reject unsupported assistant self-history", () => {
  const chat = fs.readFileSync("api/chat.js", "utf8")
  const summary = fs.readFileSync("lib/summaryPrompt.js", "utf8")

  assert.match(chat, /不要仅凭“小C刚刚回复”中关于更早历史的自我陈述/)
  assert.match(summary, /assistant 后来对自己历史的叙述/)
  assert.match(summary, /不能覆盖更早的真实记录/)
})

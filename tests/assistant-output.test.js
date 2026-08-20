import assert from "node:assert/strict"
import test from "node:test"

import { normalizeAssistantOutput } from "../lib/assistantOutput.js"

test("keeps a normal final answer unchanged", () => {
  const content = "宝宝我觉得可以做\n第二段也保留。"
  assert.equal(normalizeAssistantOutput({ role: "assistant", content }), content)
})

test("removes a thinking block and keeps the final answer", () => {
  const content = `<thinking>
internal reasoning
</thinking>

宝宝我觉得可以做`
  assert.equal(normalizeAssistantOutput({ role: "assistant", content }), "宝宝我觉得可以做")
})

test("keeps all final answer paragraphs after thinking", () => {
  const content = `<thinking>
internal reasoning
</thinking>

第一段

第二段
第三段`
  assert.equal(
    normalizeAssistantOutput({ role: "assistant", content }),
    "第一段\n\n第二段\n第三段",
  )
})

test("removes multiple explicit reasoning blocks", () => {
  const content = `<thinking>
first
</thinking>
正文一
<analysis>
second
</analysis>
正文二`
  assert.equal(normalizeAssistantOutput({ role: "assistant", content }), "正文一\n正文二")
})

test("removes a complete one-line reasoning block", () => {
  const content = `<thinking>internal reasoning</thinking>
最终回答`
  assert.equal(normalizeAssistantOutput({ role: "assistant", content }), "最终回答")
})

test("removes an analysis block and keeps final answer", () => {
  const content = `<analysis>
internal analysis
</analysis>
最后回答`
  assert.equal(normalizeAssistantOutput({ role: "assistant", content }), "最后回答")
})

test("does not expose an unterminated reasoning block", () => {
  const content = `<thinking>
internal reasoning without a closing tag`
  assert.equal(normalizeAssistantOutput({ role: "assistant", content }), "")
})

test("ignores provider structured reasoning fields and blocks", () => {
  const message = {
    role: "assistant",
    reasoning: "private reasoning",
    thinking: "private thinking",
    content: [
      { type: "thinking", thinking: "private block" },
      { type: "text", text: "最终" },
      { type: "reasoning", text: "private block 2" },
      { type: "output_text", text: "回答" },
    ],
  }

  assert.equal(normalizeAssistantOutput(message), "最终回答")
})

test("does not strip thinking tags inside Markdown code fences", () => {
  const content = `示例：
\`\`\`xml
<thinking>
example
</thinking>
\`\`\`
上面是代码。`
  assert.equal(normalizeAssistantOutput({ role: "assistant", content }), content)
})

test("does not strip inline discussion of a thinking tag", () => {
  const content = "这里讨论 <thinking> 标签，不是模型推理块。"
  assert.equal(normalizeAssistantOutput({ role: "assistant", content }), content)
})

test("does not modify user input", () => {
  const content = `<thinking>
这是用户输入
</thinking>`
  assert.equal(normalizeAssistantOutput({ role: "user", content }), content)
})

test("sanitizes a previously stored assistant message before reuse", () => {
  const storedMessage = {
    role: "assistant",
    content: `<thinking>\nprivate history\n</thinking>\n\n可见历史回复`,
    created_at: "2026-08-20T01:14:36.419016+00:00",
  }

  assert.equal(normalizeAssistantOutput(storedMessage), "可见历史回复")
})

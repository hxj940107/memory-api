import test from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFileSync } from "node:fs"
import { buildClaudeRequest } from "../lib/claudeRequest.js"
import { AI_MODELS, AI_ENDPOINTS, normalizeChatModel } from "../lib/aiConfig.js"

for (const name of ["sonnet", "opus", "haiku"]) {
  test(`${name} 5.5 adapts sampling and reasoning without changing messages, tools or budget`, () => {
    const body = { model: `anthropic/claude-${name}-5.5`, temperature: 0.55, top_p: 0.9, top_k: 10,
      reasoning_effort: "high", include_reasoning: true, max_tokens: 220,
      messages: [{ role: "system", content: [{ type: "text", text: "synthetic", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
      tools: [{ type: "function", function: { name: "shared_album" } }], tool_choice: "auto", session_id: "synthetic", response_format: { type: "json_object" } }
    const out = buildClaudeRequest(body)
    for (const field of ["temperature", "top_p", "top_k", "reasoning_effort", "include_reasoning"]) assert.equal(field in out, false)
    assert.equal(out.messages, body.messages)
    assert.equal(out.tools, body.tools)
    assert.equal(out.response_format, body.response_format)
    assert.equal(out.session_id, body.session_id)
    assert.equal(out.max_tokens, 220)
    assert.deepEqual(out.reasoning, name === "haiku" ? { enabled: false, exclude: true } : { effort: "low", exclude: true })
    assert.equal(body.temperature, 0.55)
  })
}
test("other models retain their existing parameters", () => {
  const body = { model: "anthropic/claude-opus-5", temperature: 0.55 }
  assert.equal(buildClaudeRequest(body), body)
})
test("real chat transport sends compatible payload and preserves raw tool/reasoning data", async () => {
  const source = readFileSync("api/chat.js", "utf8")
  const code = source.slice(source.indexOf("async function callLLM("), source.indexOf("async function loadBoundSharedContext("))
  let sent
  const raw = { choices: [{ message: { content: "synthetic reply", tool_calls: [{ id: "tool-1" }], reasoning_details: [{ type: "reasoning.encrypted", data: "synthetic" }] } }], usage: {} }
  const call = vm.runInNewContext(code + "\ncallLLM", {
    AI_MODELS, AI_ENDPOINTS, buildClaudeRequest, process: { env: {} }, normalizeAssistantOutput: m => m.content,
    fetch: async (_url, options) => { sent = JSON.parse(options.body); return { ok: true, json: async () => raw } },
  })
  const result = await call([{ role: "user", content: "synthetic" }], undefined, { temperature: 0, max_tokens: 800 })
  assert.equal(sent.model, AI_MODELS.chat)
  assert.equal(sent.temperature, undefined)
  assert.equal(result.raw, raw)
  assert.equal(result.reply, "synthetic reply")
  await call([{ role: "user", content: "synthetic" }], normalizeChatModel("anthropic/claude-sonnet-4.6"), { temperature: 0.55, max_tokens: 800 })
  assert.equal(sent.model, "anthropic/claude-sonnet-4.6")
  assert.equal(sent.temperature, 0.55)
  assert.equal(sent.reasoning, undefined)
})

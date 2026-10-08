import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { buildMemoryJudgePrompt, judgeMemory, XIAOC_MEMORY_GROUNDING_POLICY_VERSION } from "../lib/memoryJudge.js"
import { runXiaoCMemoryNativeCapture } from "../lib/xiaocMemoryNativeCapture.js"

const sourceId = "40000000-0000-4000-8000-000000000001"
const evidence = "我一直喜欢纸质日历"
const sources = [{ id: sourceId, role: "user", content: evidence }]
const response = value => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }) })
const candidate = content => ({
  save: true, category: "personal_fact", content,
  source_role: "user", source_message_id: sourceId,
  evidence_text: evidence, evidence_type: "assertion",
})

test("rendered prompt equals the designated historical template byte for byte", () => {
  const historical = execFileSync("git", ["show", "05e23cb20030f687c63e452dc054970a11f28930:lib/memoryJudge.js"], { encoding: "utf8" })
  const start = historical.indexOf("  const prompt = `") + "  const prompt = `".length
  const template = historical.slice(start, historical.indexOf("\n`", start))
  const expected = template
    .replace("${message}", evidence)
    .replace("${JSON.stringify(allowedUserSources)}", JSON.stringify(sources))
    .replace("${previousContent}", "虚构的上一条消息")
    .replace("${assistantContext}", "虚构的小C回复")
    + "\n"
  assert.equal(buildMemoryJudgePrompt({ message: evidence, allowedUserSources: sources,
    previousContent: "虚构的上一条消息", assistantContext: "虚构的小C回复" }), expected)
})

test("database-style subjects fail before grounding or persistence", async () => {
  for (const content of ["用户喜欢纸质日历。", "该用户喜欢纸质日历。", "The user likes paper calendars."]) {
    let grounded = false
    const result = await judgeMemory(evidence, {
      allowedUserSources: sources, fetchImpl: async () => response(candidate(content)),
      groundingVerifier: async () => { grounded = true; return { supported: true, reason_code: "SUPPORTED" } },
    })
    assert.equal(result.save, false)
    assert.equal(result.reason, "canonical_perspective_invalid")
    assert.equal(grounded, false)
  }
})

test("old JSON adapts to native capture while natural perspective is preserved", async () => {
  for (const content of ["她一直喜欢纸质日历。", "她希望小C记得这件事。", "她希望我记得这件事。"]) {
    const result = await judgeMemory(evidence, {
      allowedUserSources: sources, fetchImpl: async () => response(candidate(content)),
      groundingVerifier: async () => ({ supported: true, reason_code: "SUPPORTED" }),
    })
    assert.equal(result.content, content)
    assert.equal(result.memory_type, "stable_fact")
    assert.deepEqual(result.temporal, { event_time: null, valid_from: null, valid_until: null })
    let captured = null
    const capture = await runXiaoCMemoryNativeCapture({
      client: { rpc: async (name, input) => { captured = { name, input }; return { data: "fixture-memory", error: null } } },
      env: { XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED: "true" },
      trustedUserId: "user", requestedUserId: "user", currentMessageId: sourceId,
      sourceMessageId: sourceId, currentConversationId: "fictional", sourceConversationId: "fictional",
      currentMessage: evidence, sourceMessage: evidence, judgeResult: result,
    })
    assert.equal(capture.outcome, "success")
    assert.equal(captured.name, "xiaoc_memory_capture_verified")
    assert.equal(captured.input.p_canonical_content, content)
  }
})

test("assistant attribution and unsupported facts cannot pass grounding", async () => {
  const result = await judgeMemory(evidence, {
    allowedUserSources: sources, assistantContext: "我喜欢收集邮票。",
    fetchImpl: async () => response(candidate("她喜欢收集邮票。")),
    groundingVerifier: async () => ({ supported: false, reason_code: "AMBIGUOUS_ATTRIBUTION" }),
  })
  assert.equal(result.save, false)
  assert.equal(result.reason, "unsupported_canonical")
  assert.equal(result.validation_reason, "AMBIGUOUS_ATTRIBUTION")
})

test("development rejection remains unwritten without a grounding call", async () => {
  let calls = 0
  const result = await judgeMemory("这个虚构按钮正在调试", {
    allowedUserSources: sources,
    fetchImpl: async () => { calls++; return response({ save: false, category: "project_dev", content: "" }) },
  })
  assert.equal(result.save, false)
  assert.equal(result.content, "")
  assert.equal(calls, 1)
})

test("native write boundary also rejects database-style content", async () => {
  let writes = 0
  const result = await runXiaoCMemoryNativeCapture({
    client: { rpc: async () => { writes++; return { data: "unexpected" } } },
    env: { XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED: "true" },
    trustedUserId: "user", requestedUserId: "user", currentMessageId: sourceId,
    sourceMessageId: sourceId, currentConversationId: "fictional", sourceConversationId: "fictional",
    currentMessage: evidence, sourceMessage: evidence,
    judgeResult: { save: true, category: "personal_fact", memory_type: "stable_fact", content: "用户喜欢纸质日历。",
      provenance: { source_role: "user", source_message_id: sourceId, evidence_text: evidence, evidence_type: "assertion" },
      grounding: { verified: true, policy_version: XIAOC_MEMORY_GROUNDING_POLICY_VERSION } },
  })
  assert.equal(writes, 0)
  assert.equal(result.reason_code, "CANONICAL_PERSPECTIVE_INVALID")
})

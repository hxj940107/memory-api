import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"

import {
  runXiaoCMemoryNativeCapture,
  validateXiaoCMemoryNativeCaptureInput,
  XIAOC_MEMORY_NATIVE_CAPTURE_POLICY_VERSION,
} from "../lib/xiaocMemoryNativeCapture.js"

const messageId = "10000000-0000-4000-8000-000000000001"
const conversationId = "conversation-1"
const base = {
  trustedUserId: "user", requestedUserId: "user", currentMessageId: messageId, sourceMessageId: messageId,
  currentConversationId: conversationId, sourceConversationId: conversationId,
  currentMessage: "我去过冰岛看极光",
  judgeResult: { save: true, category: "meaningful_experience", content: "她去过冰岛看极光",
    provenance: { source_role: "user", source_message_id: messageId, evidence_text: "我去过冰岛看极光", evidence_type: "assertion" } },
}

test("native capture is default off and does not call RPC", async () => {
  const client = { calls: 0, rpc() { this.calls += 1 } }
  const result = await runXiaoCMemoryNativeCapture({ client, ...base, env: {} })
  assert.equal(result.reason_code, "FLAG_OFF")
  assert.equal(client.calls, 0)
})

test("narrow mapping is observation-only, nullable, exact and idempotent", () => {
  const result = validateXiaoCMemoryNativeCaptureInput(base)
  assert.equal(result.eligible, true)
  assert.equal(result.input.p_memory_class, "observation")
  assert.equal(result.input.p_category, "meaningful_experience")
  for (const field of ["p_claim_key", "p_event_time", "p_valid_from", "p_valid_until", "p_importance", "p_confidence"]) assert.equal(result.input[field], null)
  assert.equal(result.input.p_capture_policy_version, XIAOC_MEMORY_NATIVE_CAPTURE_POLICY_VERSION)
  assert.equal(result.input.p_idempotency_key, `native-capture-shadow-v1:${messageId}`)
})

test("identity, provenance, ambiguity, category and direct-support violations fail closed", () => {
  const cases = [
    [{ requestedUserId: "other" }, "OWNER_MISMATCH"],
    [{ currentMessageId: "local-id", sourceMessageId: "local-id", judgeResult: { ...base.judgeResult, provenance: { ...base.judgeResult.provenance, source_message_id: "local-id" } } }, "CURRENT_PERSISTED_MESSAGE_REQUIRED"],
    [{ sourceMessageId: "20000000-0000-4000-8000-000000000002" }, "CURRENT_PERSISTED_MESSAGE_REQUIRED"],
    [{ sourceConversationId: "other" }, "CONVERSATION_MISMATCH"],
    [{ judgeResult: { ...base.judgeResult, category: "personal_fact" } }, "UNSUPPORTED_CATEGORY"],
    [{ judgeResult: { ...base.judgeResult, provenance: { ...base.judgeResult.provenance, source_role: "assistant" } } }, "PROVENANCE_MISMATCH"],
    [{ judgeResult: { ...base.judgeResult, provenance: { ...base.judgeResult.provenance, evidence_type: "question", evidence_text: "我去过冰岛吗？" } }, currentMessage: "我去过冰岛吗？" }, "PROVENANCE_MISMATCH"],
    [{ judgeResult: { ...base.judgeResult, provenance: { ...base.judgeResult.provenance, evidence_type: "correction" } } }, "PROVENANCE_MISMATCH"],
    [{ currentMessage: "我正在测试数据库", judgeResult: { ...base.judgeResult, content: "她正在测试数据库", provenance: { ...base.judgeResult.provenance, evidence_text: "我正在测试数据库" } } }, "UNSAFE_OR_MUTABLE_EVIDENCE"],
    [{ currentMessage: "新闻说冰岛有极光", judgeResult: { ...base.judgeResult, content: "冰岛有极光", provenance: { ...base.judgeResult.provenance, evidence_text: "新闻说冰岛有极光" } } }, "UNSAFE_OR_MUTABLE_EVIDENCE"],
    [{ judgeResult: { ...base.judgeResult, content: "她去过冰岛看极光并住了三年" } }, "CANONICAL_CONTENT_NOT_DIRECTLY_SUPPORTED"],
  ]
  for (const [override, reason] of cases) assert.equal(validateXiaoCMemoryNativeCaptureInput({ ...base, ...override }).reasonCode, reason)
})

test("RPC success and idempotent duplicate-success are safe and use the exact same key", async () => {
  const calls = []
  const client = { rpc: async (name, params) => { calls.push([name, params]); return { data: messageId, error: null } },
    from: () => ({ insert: async () => ({ error: null }) }) }
  const env = { XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED: "true" }
  for (let i = 0; i < 2; i += 1) assert.equal((await runXiaoCMemoryNativeCapture({ client, ...base, env })).outcome, "success")
  assert.equal(calls.length, 2)
  assert.equal(calls[0][1].p_idempotency_key, calls[1][1].p_idempotency_key)
})

test("RPC and audit failures cannot escape into chat", async () => {
  const result = await runXiaoCMemoryNativeCapture({ ...base,
    env: { XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED: "true", XIAOC_MEMORY_OBSERVATION_AUDIT_ENABLED: "true" },
    client: { rpc: async () => ({ error: { code: "08006" } }), from: () => ({ insert: async () => { throw new Error("audit") } }) },
    logger: { warn() {} },
  })
  assert.deepEqual(result, { attempted: true, outcome: "failure", error_code: "08006" })
})

test("chat integration is authority-independent and adds no prompt, gateway, model or mobile coupling", async () => {
  const chat = await readFile(new URL("../api/chat.js", import.meta.url), "utf8")
  const ombre = chat.indexOf("const saved = await saveLongTermMemory")
  const legacy = chat.indexOf("episodic = await saveEpisodicObservation", ombre)
  const native = chat.indexOf("await runXiaoCMemoryNativeCapture")
  assert.ok(ombre >= 0 && legacy > ombre && native > legacy)
  assert.equal((chat.match(/runXiaoCMemoryNativeCapture/g) || []).length, 2)
  assert.match(chat, /if \(!ownedFreshEmpty\) \{[\s\S]*saveLongTermMemory/)
  const helper = await readFile(new URL("../lib/xiaocMemoryNativeCapture.js", import.meta.url), "utf8")
  assert.equal(/callLLM|memoryContextGateway|saveLongTermMemory/.test(helper), false)
})

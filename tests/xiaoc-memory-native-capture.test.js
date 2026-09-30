import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"

import {
  runXiaoCMemoryNativeCapture,
  validateXiaoCMemoryNativeCaptureInput,
  XIAOC_MEMORY_NATIVE_CAPTURE_POLICY_VERSION,
} from "../lib/xiaocMemoryNativeCapture.js"
import { XIAOC_MEMORY_GROUNDING_POLICY_VERSION } from "../lib/memoryJudge.js"

const messageId = "10000000-0000-4000-8000-000000000001"
const conversationId = "conversation-1"
const base = {
  trustedUserId: "user", requestedUserId: "user", currentMessageId: messageId, sourceMessageId: messageId,
  currentConversationId: conversationId, sourceConversationId: conversationId,
  currentMessage: "我去过冰岛看极光",
  judgeResult: { save: true, category: "meaningful_experience", memory_type: "meaningful_experience",
    content: "她曾亲眼看过北方群岛的极光",
    temporal: { event_time: null, valid_from: null, valid_until: null },
    grounding: { verified: true, policy_version: XIAOC_MEMORY_GROUNDING_POLICY_VERSION },
    provenance: { source_role: "user", source_message_id: messageId, evidence_text: "我去过冰岛看极光", evidence_type: "assertion" } },
}

const categoryCases = [
  ["personal_fact", "我住在南京", "她住在南京"],
  ["relationship_memory", "我和你第一次见面是在春天", "她和小C第一次见面是在春天"],
  ["relationship_preference", "我喜欢你直接告诉我真实想法", "她喜欢小C直接告诉她真实想法"],
  ["meaningful_experience", "我去过冰岛看极光", "她去过冰岛看极光"],
  ["long_term_concern", "我一直担心家人的健康", "她一直担心家人的健康"],
]

function categoryContext(category, evidenceText, content, overrides = {}) {
  return {
    ...base,
    currentMessage: evidenceText,
    judgeResult: {
      ...base.judgeResult,
      category,
      content,
      provenance: {
        ...base.judgeResult.provenance,
        evidence_text: evidenceText,
      },
    },
    ...overrides,
  }
}

test("native capture is default off and does not call RPC", async () => {
  const client = { calls: 0, rpc() { this.calls += 1 } }
  const result = await runXiaoCMemoryNativeCapture({ client, ...base, env: {} })
  assert.equal(result.reason_code, "FLAG_OFF")
  assert.equal(client.calls, 0)
})

test("all five judge categories map to grounded canonical observations", () => {
  for (const [category, evidenceText, content] of categoryCases) {
    const result = validateXiaoCMemoryNativeCaptureInput(categoryContext(category, evidenceText, content))
    assert.equal(result.eligible, true, category)
    assert.equal(result.input.p_memory_class, "observation")
    assert.equal(result.input.p_category, category)
    assert.equal(result.input.p_evidence_text, evidenceText)
    assert.equal(result.input.p_canonical_content, content)
    for (const field of ["p_claim_key", "p_event_time", "p_valid_from", "p_valid_until", "p_importance", "p_confidence"]) {
      assert.equal(result.input[field], null, `${category}:${field}`)
    }
    assert.equal(result.input.p_capture_policy_version, XIAOC_MEMORY_NATIVE_CAPTURE_POLICY_VERSION)
    assert.equal(result.input.p_idempotency_key, `native-capture-v2:${messageId}:${messageId}`)
  }
})

test("all five supported categories execute only the protected native capture RPC", async () => {
  for (const [category, evidenceText, content] of categoryCases) {
    const calls = []
    const client = {
      async rpc(name, input) {
        calls.push({ name, input })
        return { data: messageId, error: null }
      },
    }
    const result = await runXiaoCMemoryNativeCapture({
      client,
      env: { XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED: "true" },
      ...categoryContext(category, evidenceText, content),
    })

    assert.equal(result.outcome, "success", category)
    assert.equal(calls.length, 1, category)
    assert.equal(calls[0].name, "xiaoc_memory_capture_verified")
    assert.equal(calls[0].input.p_category, category)
  }
})

test("each supported category retains owner, message, conversation, provenance, and grounding gates", () => {
  for (const [category, evidenceText, content] of categoryCases) {
    const context = categoryContext(category, evidenceText, content)
    const invalidCases = [
      [{ requestedUserId: "other" }, "OWNER_MISMATCH"],
      [{ sourceMessageId: "20000000-0000-4000-8000-000000000002" }, "PERSISTED_MESSAGE_REQUIRED"],
      [{ sourceConversationId: "other" }, "CONVERSATION_MISMATCH"],
      [{ currentMessage: `前缀${evidenceText}后缀`, judgeResult: {
        ...context.judgeResult,
        provenance: { ...context.judgeResult.provenance, evidence_text: `${evidenceText.slice(0, 2)}不存在的中间段` },
      } }, "EVIDENCE_NOT_EXACT_SUBSTRING"],
      [{ judgeResult: { ...context.judgeResult, grounding: null } }, "GROUNDING_NOT_VERIFIED"],
    ]
    for (const [override, reason] of invalidCases) {
      assert.equal(
        validateXiaoCMemoryNativeCaptureInput({ ...context, ...override }).reasonCode,
        reason,
        `${category}:${reason}`,
      )
    }
  }
})

test("identity, provenance, ambiguity, category and grounding violations fail closed", () => {
  const cases = [
    [{ requestedUserId: "other" }, "OWNER_MISMATCH"],
    [{ currentMessageId: "local-id", sourceMessageId: "local-id", judgeResult: { ...base.judgeResult, provenance: { ...base.judgeResult.provenance, source_message_id: "local-id" } } }, "PERSISTED_MESSAGE_REQUIRED"],
    [{ sourceMessageId: "20000000-0000-4000-8000-000000000002" }, "PERSISTED_MESSAGE_REQUIRED"],
    [{ sourceConversationId: "other" }, "CONVERSATION_MISMATCH"],
    [{ judgeResult: { ...base.judgeResult, category: "unsupported" } }, "CATEGORY_INVALID"],
    [{ judgeResult: { ...base.judgeResult, memory_type: "unsupported" } }, "MEMORY_TYPE_INVALID"],
    [{ judgeResult: { ...base.judgeResult, provenance: { ...base.judgeResult.provenance, source_role: "assistant" } } }, "SOURCE_ROLE_INVALID"],
    [{ judgeResult: { ...base.judgeResult, provenance: { ...base.judgeResult.provenance, evidence_type: "invented_type" } } }, "EVIDENCE_TYPE_INVALID"],
    [{ judgeResult: { ...base.judgeResult, grounding: null } }, "GROUNDING_NOT_VERIFIED"],
    [{ judgeResult: { ...base.judgeResult, temporal: { event_time: "not-a-time", valid_from: null, valid_until: null } } }, "TEMPORAL_FORMAT_INVALID"],
    [{ judgeResult: { ...base.judgeResult, temporal: {
      event_time: null,
      valid_from: "2027-02-02T09:00:00+08:00",
      valid_until: "2027-02-01T09:00:00+08:00",
    } } }, "TEMPORAL_RANGE_INVALID"],
  ]
  for (const [override, reason] of cases) assert.equal(validateXiaoCMemoryNativeCaptureInput({ ...base, ...override }).reasonCode, reason)
})

test("question and trailing question-mark evidence remain eligible when provenance is exact", () => {
  for (const evidenceType of ["question", "other"]) {
    for (const punctuation of ["?", "？"]) {
      const evidenceText = `我一直使用纸质日历，这样可以吗${punctuation}`
      const result = validateXiaoCMemoryNativeCaptureInput({
        ...base,
        currentMessage: evidenceText,
        judgeResult: {
          ...base.judgeResult,
          content: "她一直使用纸质日历。",
          provenance: {
            ...base.judgeResult.provenance,
            evidence_text: evidenceText,
            evidence_type: evidenceType,
          },
        },
      })
      assert.equal(result.eligible, true)
      assert.equal(result.input.p_evidence_type, evidenceType)
    }
  }
})

test("RPC success and idempotent duplicate-success are safe and use the exact same key", async () => {
  const calls = []
  const rows = new Map()
  const client = { rpc: async (name, params) => {
    calls.push([name, params])
    if (!rows.has(params.p_idempotency_key)) rows.set(params.p_idempotency_key, { id: messageId, ...params })
    return { data: rows.get(params.p_idempotency_key).id, error: null }
  },
    from: () => ({ insert: async () => ({ error: null }) }) }
  const env = { XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED: "true" }
  for (let i = 0; i < 2; i += 1) assert.equal((await runXiaoCMemoryNativeCapture({ client, ...base, env })).outcome, "success")
  assert.equal(calls.length, 2)
  assert.equal(calls[0][1].p_idempotency_key, calls[1][1].p_idempotency_key)
  assert.equal(rows.size, 1)
})

test("RPC and audit failures cannot escape into chat", async () => {
  const result = await runXiaoCMemoryNativeCapture({ ...base,
    env: { XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED: "true", XIAOC_MEMORY_OBSERVATION_AUDIT_ENABLED: "true" },
    client: { rpc: async () => ({ error: { code: "08006" } }), from: () => ({ insert: async () => { throw new Error("audit") } }) },
    logger: { warn() {} },
  })
  assert.deepEqual(result, { attempted: true, outcome: "failure", error_code: "08006" })
})

test("embedding failure cannot undo successful native capture", async () => {
  const chain = { select() { return this }, eq() { return this }, limit() { return this }, maybeSingle: async () => ({ data: null, error: null }) }
  const client = {
    async rpc(name) { return name === "xiaoc_memory_capture_verified" ? { data: messageId, error: null } : { data: null, error: null } },
    from() { return chain },
  }
  const result = await runXiaoCMemoryNativeCapture({ client, ...base,
    env: { XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED: "true" },
    embeddingProvider: { embed: async () => { throw new Error("EMBEDDING_PROVIDER_REQUEST_FAILED") } },
    logger: { warn() {}, log() {} },
  })
  assert.equal(result.outcome, "success")
  assert.equal(result.memory_id, messageId)
  assert.equal(result.embedding, "failed")
})

test("native capture remains authority-independent while Ombre persistence is explicitly scoped", async () => {
  const chat = await readFile(new URL("../api/chat.js", import.meta.url), "utf8")
  const ombre = chat.indexOf("const saved = await saveLongTermMemory")
  const legacy = chat.indexOf("episodic = await saveEpisodicObservation", ombre)
  const native = chat.indexOf("await runXiaoCMemoryNativeCapture")
  assert.ok(ombre >= 0 && legacy > ombre && native > legacy)
  assert.equal((chat.match(/runXiaoCMemoryNativeCapture/g) || []).length, 2)
  assert.match(chat, /if \(memoryAuthorityMode === MEMORY_AUTHORITY_MODE\.OMBRE_AUTHORITATIVE\) \{[\s\S]*saveLongTermMemory/)
  const helper = await readFile(new URL("../lib/xiaocMemoryNativeCapture.js", import.meta.url), "utf8")
  assert.equal(/callLLM|memoryContextGateway|saveLongTermMemory/.test(helper), false)
})

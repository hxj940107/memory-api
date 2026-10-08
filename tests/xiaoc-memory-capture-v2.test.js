import assert from "node:assert/strict"
import test from "node:test"

import { evaluateMemoryJudgePrecheck } from "../lib/aiConfig.js"
import {
  buildMemoryJudgePrompt,
  judgeMemory,
  validateCanonicalGroundingDecision,
  validateUserMemoryProvenance,
  XIAOC_MEMORY_GROUNDING_POLICY_VERSION,
} from "../lib/memoryJudge.js"
import {
  runXiaoCMemoryNativeCapture,
  validateXiaoCMemoryNativeCaptureInput,
} from "../lib/xiaocMemoryNativeCapture.js"
import { writeXiaoCMemoryCaptureStageAudit } from "../lib/xiaocMemoryObservationAudit.js"

const currentMessageId = "30000000-0000-4000-8000-000000000003"
const previousMessageId = "30000000-0000-4000-8000-000000000002"
const conversationId = "fictional-conversation"

function groundedJudgeResult(overrides = {}) {
  return {
    save: true,
    category: "personal_fact",
    memory_type: "stable_fact",
    content: "她长期坚持创作木雕。",
    temporal: { event_time: null, valid_from: null, valid_until: null },
    grounding: { verified: true, policy_version: XIAOC_MEMORY_GROUNDING_POLICY_VERSION },
    provenance: {
      source_role: "user",
      source_message_id: currentMessageId,
      evidence_text: "我一直坚持做木雕",
      evidence_type: "assertion",
    },
    ...overrides,
  }
}

function captureContext(overrides = {}) {
  return {
    trustedUserId: "user",
    requestedUserId: "user",
    currentMessageId,
    sourceMessageId: currentMessageId,
    currentConversationId: conversationId,
    sourceConversationId: conversationId,
    sourceMessage: "我一直坚持做木雕",
    currentMessage: "我一直坚持做木雕",
    judgeResult: groundedJudgeResult(),
    ...overrides,
  }
}

function modelResponse(payload) {
  return {
    ok: true,
    async json() {
      return { choices: [{ message: { content: JSON.stringify(payload) } }], usage: {} }
    },
  }
}

test("minimal precheck admits short meaningful and formerly unlisted semantic messages", () => {
  assert.equal(evaluateMemoryJudgePrecheck("我已戒糖").eligible, true)
  assert.equal(evaluateMemoryJudgePrecheck("明年我会参加一项长期志愿服务").eligible, true)
})

test("minimal precheck only skips empty, pure noise, and deterministic acknowledgement", () => {
  assert.deepEqual(evaluateMemoryJudgePrecheck("   "), { eligible: false, reason: "PRECHECK_EMPTY" })
  assert.deepEqual(evaluateMemoryJudgePrecheck("……!!!"), { eligible: false, reason: "PRECHECK_PURE_NOISE" })
  assert.deepEqual(evaluateMemoryJudgePrecheck("收到"), { eligible: false, reason: "PRECHECK_MECHANICAL_ACK" })
  assert.equal(evaluateMemoryJudgePrecheck("哈哈，我终于做到了").eligible, true)
})

test("judge save=false returns without a grounding call", async () => {
  let calls = 0
  const result = await judgeMemory("随口聊一句", {
    allowedUserSources: [{ id: currentMessageId, role: "user", content: "随口聊一句" }],
    fetchImpl: async () => {
      calls += 1
      return modelResponse({ save: false, category: "casual_chat", memory_type: "none", content: "" })
    },
  })
  assert.equal(result.save, false)
  assert.equal(result.model_save, false)
  assert.equal(result.category, "casual_chat")
  assert.equal(calls, 1)
})

test("raw model save=true remains observable when temporal grounding rejects it", async () => {
  const evidence = "我一直使用纸质日历，这样可以吗？"
  const result = await judgeMemory(evidence, {
    allowedUserSources: [{ id: currentMessageId, role: "user", content: evidence }],
    fetchImpl: async () => modelResponse({
      save: true,
      category: "personal_fact",
      memory_type: "stable_fact",
      content: "她从某个精确日期开始一直使用纸质日历。",
      source_role: "user",
      source_message_id: currentMessageId,
      evidence_text: evidence,
      evidence_type: "question",
      temporal: { event_time: null, valid_from: null, valid_until: null },
    }),
    groundingVerifier: async () => ({ supported: false, reason_code: "UNSUPPORTED_TEMPORAL" }),
  })
  assert.equal(result.save, false)
  assert.equal(result.model_save, true)
  assert.equal(result.reason, "unsupported_canonical")
  assert.equal(result.validation_reason, "UNSUPPORTED_TEMPORAL")
})

test("faithful paraphrase is admitted only with explicit semantic grounding verification", () => {
  const supported = validateXiaoCMemoryNativeCaptureInput(captureContext())
  assert.equal(supported.eligible, true)
  const unverified = validateXiaoCMemoryNativeCaptureInput(captureContext({
    judgeResult: groundedJudgeResult({ grounding: null }),
  }))
  assert.equal(unverified.reasonCode, "GROUNDING_NOT_VERIFIED")
  assert.deepEqual(validateCanonicalGroundingDecision({ supported: false, reason_code: "UNSUPPORTED_FACT" }), {
    supported: false,
    reason_code: "UNSUPPORTED_FACT",
  })
})

test("correction is first-class verified evidence", () => {
  const evidence = "更正一下，我固定使用左手写字"
  const result = validateXiaoCMemoryNativeCaptureInput(captureContext({
    sourceMessage: evidence,
    currentMessage: evidence,
    judgeResult: groundedJudgeResult({
      memory_type: "correction",
      content: "她固定使用左手写字。",
      provenance: {
        source_role: "user",
        source_message_id: currentMessageId,
        evidence_text: evidence,
        evidence_type: "correction",
      },
    }),
  }))
  assert.equal(result.eligible, true)
  assert.equal(result.input.p_evidence_type, "correction")
})

test("meaningful temporal plan is admissible and vague time remains null", () => {
  const evidence = "我准备参加明年的社区合唱演出"
  const vague = validateXiaoCMemoryNativeCaptureInput(captureContext({
    sourceMessage: evidence,
    currentMessage: evidence,
    judgeResult: groundedJudgeResult({
      category: "meaningful_experience",
      memory_type: "temporal_plan",
      content: "她准备参加明年的社区合唱演出。",
      provenance: {
        source_role: "user",
        source_message_id: currentMessageId,
        evidence_text: evidence,
        evidence_type: "assertion",
      },
    }),
  }))
  assert.equal(vague.eligible, true)
  assert.equal(vague.input.p_event_time, null)

  const explicit = validateXiaoCMemoryNativeCaptureInput(captureContext({
    sourceMessage: evidence,
    currentMessage: evidence,
    judgeResult: groundedJudgeResult({
      category: "meaningful_experience",
      memory_type: "temporal_plan",
      content: "她准备参加社区合唱演出。",
      temporal: { event_time: "2027-01-15T19:00:00+08:00", valid_from: null, valid_until: null },
      provenance: {
        source_role: "user",
        source_message_id: currentMessageId,
        evidence_text: evidence,
        evidence_type: "assertion",
      },
    }),
  }))
  assert.equal(explicit.eligible, true)
  assert.equal(explicit.input.p_event_time, "2027-01-15T11:00:00.000Z")
})

test("previous persisted user message can remain the exact provenance source", () => {
  const source = "我长期参加社区读书会"
  const result = validateXiaoCMemoryNativeCaptureInput(captureContext({
    sourceMessageId: previousMessageId,
    sourceMessage: source,
    judgeResult: groundedJudgeResult({
      content: "她长期参加社区读书会。",
      provenance: {
        source_role: "user",
        source_message_id: previousMessageId,
        evidence_text: source,
        evidence_type: "assertion",
      },
    }),
  }))
  assert.equal(result.eligible, true)
  assert.equal(result.input.p_source_message_id, previousMessageId)
})

test("exact active canonical duplicate does not create another memory", async () => {
  let rpcCalls = 0
  const auditRows = []
  const memoryQuery = {
    select() { return this },
    eq() { return this },
    limit() { return this },
    async maybeSingle() { return { data: { id: "40000000-0000-4000-8000-000000000004" }, error: null } },
  }
  const client = {
    from(name) {
      if (name === "memory_items") return memoryQuery
      return { async insert(row) { auditRows.push(row); return { error: null } } }
    },
    async rpc() { rpcCalls += 1; return { data: currentMessageId, error: null } },
  }
  const result = await runXiaoCMemoryNativeCapture({
    client,
    env: {
      XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED: "true",
      XIAOC_MEMORY_OBSERVATION_AUDIT_ENABLED: "true",
    },
    ...captureContext(),
  })
  assert.equal(result.outcome, "duplicate")
  assert.equal(rpcCalls, 0)
  assert.equal(auditRows[0].reason_code, "DEDUPED_EXACT_ACTIVE_STABLE_FACT")
})

test("capture audit distinguishes precheck, judge false, validation, and persistence stages", async () => {
  const rows = []
  const client = { from: () => ({ async insert(row) { rows.push(row); return { error: null } } }) }
  const env = { XIAOC_MEMORY_OBSERVATION_AUDIT_ENABLED: "true" }
  await writeXiaoCMemoryCaptureStageAudit({
    client, env, userId: "user", messageId: currentMessageId,
    outcome: "skipped", reasonCode: "PRECHECK_PURE_NOISE",
  })
  await writeXiaoCMemoryCaptureStageAudit({
    client, env, userId: "user", messageId: currentMessageId,
    outcome: "empty", reasonCode: "JUDGE_SAVE_FALSE_CASUAL_CHAT",
  })
  await writeXiaoCMemoryCaptureStageAudit({
    client, env, userId: "user", messageId: currentMessageId,
    outcome: "failure", errorCode: "MEMORY_JUDGE_PARSE_ERROR",
  })
  assert.deepEqual(rows.map(row => [row.outcome, row.reason_code, row.error_code]), [
    ["skipped", "PRECHECK_PURE_NOISE", null],
    ["empty", "JUDGE_SAVE_FALSE_CASUAL_CHAT", null],
    ["failure", null, "MEMORY_JUDGE_PARSE_ERROR"],
  ])
})

test("restored judge prompt retains the historical save and exclusion standards", () => {
  const prompt = buildMemoryJudgePrompt({ message: "虚构输入" })
  assert.match(prompt, /不要保存：[\s\S]*临时情绪/)
  assert.match(prompt, /如果是项目开发信息，默认不要进入私人长期记忆/)
  assert.match(prompt, /值得保存：[\s\S]*长期习惯/)
  assert.match(prompt, /不是关键词过滤器/)
})

test("owner, conversation and exact evidence protections remain fail closed while questions are allowed", () => {
  const cases = [
    [captureContext({ requestedUserId: "other" }), "OWNER_MISMATCH"],
    [captureContext({ sourceConversationId: "other" }), "CONVERSATION_MISMATCH"],
    [captureContext({ sourceMessage: "不同原文" }), "EVIDENCE_NOT_EXACT_SUBSTRING"],
  ]
  for (const [context, reason] of cases) {
    assert.equal(validateXiaoCMemoryNativeCaptureInput(context).reasonCode, reason)
  }

  for (const punctuation of ["?", "？"]) {
    const evidence = `我一直使用纸质日历，这样可以吗${punctuation}`
    const result = validateXiaoCMemoryNativeCaptureInput(captureContext({
      sourceMessage: evidence,
      currentMessage: evidence,
      judgeResult: groundedJudgeResult({
        content: "她一直使用纸质日历。",
        provenance: {
          source_role: "user",
          source_message_id: currentMessageId,
          evidence_text: evidence,
          evidence_type: "question",
        },
      }),
    }))
    assert.equal(result.eligible, true)
    assert.equal(result.input.p_evidence_type, "question")
  }
})

test("temporal validation distinguishes malformed format and reversed range", () => {
  const source = { id: currentMessageId, role: "user", content: "我准备参加明年的社区演出" }
  const baseResult = {
    save: true,
    category: "meaningful_experience",
    memory_type: "temporal_plan",
    content: "她准备参加明年的社区演出。",
    source_role: "user",
    source_message_id: currentMessageId,
    evidence_text: source.content,
    evidence_type: "assertion",
  }
  const malformed = validateUserMemoryProvenance({
    ...baseResult,
    temporal: { event_time: "明年", valid_from: null, valid_until: null },
  }, [source])
  assert.equal(malformed.save, false)
  assert.equal(malformed.reason, "temporal_format_invalid")

  const reversed = validateUserMemoryProvenance({
    ...baseResult,
    temporal: {
      event_time: null,
      valid_from: "2027-02-02T09:00:00+08:00",
      valid_until: "2027-02-01T09:00:00+08:00",
    },
  }, [source])
  assert.equal(reversed.save, false)
  assert.equal(reversed.reason, "temporal_range_invalid")
})

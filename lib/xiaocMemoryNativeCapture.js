import {
  bestEffortWriteXiaoCMemoryObservationAudit,
  buildXiaoCMemoryCorrelationHash,
  buildXiaoCMemoryNativeCaptureAuditRow,
} from "./xiaocMemoryObservationAudit.js"
import { normalizeLexicalText } from "./xiaocMemoryLexical.js"

export const XIAOC_MEMORY_NATIVE_CAPTURE_POLICY_VERSION = "xiaoc-native-capture-shadow-v1"
export const XIAOC_MEMORY_NATIVE_AUTHORITY_POLICY_VERSION = "xiaoc-native-authority-v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EVIDENCE_TYPES = new Set(["assertion", "confirmation"])
const DEVELOPMENT_OR_TEST = /(?:测试|调试|部署|上线|代码|接口|数据库|Supabase|Railway|Vercel|token|bug|修复|构建|build|commit|push)/i
const MUTABLE_OR_PLANNED = /(?:现在|目前|正在|暂时|打算|准备|计划|想要|要去|会去|之后要|接下来)/
const FIRST_PERSON = /(?:我|我们|咱们|和你|跟你)/
const USER_PERSPECTIVE = /(?:她|我|我们|咱们|小c|和你|跟你)/

export function isXiaoCMemoryNativeCaptureEnabled(env = process.env) {
  return env?.XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED === "true"
}

function canonicalIsDirectlySupported(canonicalContent, evidenceText) {
  const evidence = normalizeLexicalText(evidenceText)
  const canonical = normalizeLexicalText(canonicalContent)
  if (!evidence || !canonical) return false
  const userVoiceCanonical = canonical
    .replaceAll("她", "我")
    .replaceAll("小c", "你")
  return USER_PERSPECTIVE.test(canonical) && (evidence.includes(canonical) || evidence.includes(userVoiceCanonical))
}

export function validateXiaoCMemoryNativeCaptureInput({
  trustedUserId,
  requestedUserId,
  currentMessageId,
  sourceMessageId,
  currentConversationId,
  sourceConversationId,
  currentMessage,
  judgeResult,
}) {
  const provenance = judgeResult?.provenance || {}
  const evidenceText = String(provenance.evidence_text || "").trim()
  const evidenceType = String(provenance.evidence_type || "").trim().toLowerCase()
  const canonicalContent = String(judgeResult?.content || "").trim()
  const message = String(currentMessage || "")
  const stableId = String(currentMessageId || "")

  if (!trustedUserId || trustedUserId !== requestedUserId) return { eligible: false, reasonCode: "OWNER_MISMATCH" }
  if (!UUID.test(stableId) || sourceMessageId !== stableId || provenance.source_message_id !== stableId) {
    return { eligible: false, reasonCode: "CURRENT_PERSISTED_MESSAGE_REQUIRED" }
  }
  if (!currentConversationId || sourceConversationId !== currentConversationId) {
    return { eligible: false, reasonCode: "CONVERSATION_MISMATCH" }
  }
  if (!judgeResult?.save || judgeResult.category !== "meaningful_experience") {
    return { eligible: false, reasonCode: "UNSUPPORTED_CATEGORY" }
  }
  if (provenance.source_role !== "user" || !EVIDENCE_TYPES.has(evidenceType)
    || !evidenceText || !message.includes(evidenceText) || /[?？]\s*$/.test(evidenceText)) {
    return { eligible: false, reasonCode: "PROVENANCE_MISMATCH" }
  }
  if (!FIRST_PERSON.test(evidenceText) || DEVELOPMENT_OR_TEST.test(evidenceText)
    || MUTABLE_OR_PLANNED.test(evidenceText)) {
    return { eligible: false, reasonCode: "UNSAFE_OR_MUTABLE_EVIDENCE" }
  }
  if (!canonicalIsDirectlySupported(canonicalContent, evidenceText)) {
    return { eligible: false, reasonCode: "CANONICAL_CONTENT_NOT_DIRECTLY_SUPPORTED" }
  }
  return {
    eligible: true,
    reasonCode: null,
    input: {
      p_user_id: trustedUserId,
      p_source_message_id: stableId,
      p_source_conversation_id: currentConversationId,
      p_evidence_text: evidenceText,
      p_evidence_type: evidenceType,
      p_canonical_content: canonicalContent,
      p_memory_class: "observation",
      p_category: "meaningful_experience",
      p_claim_key: null,
      p_event_time: null,
      p_valid_from: null,
      p_valid_until: null,
      p_importance: null,
      p_confidence: null,
      p_capture_policy_version: XIAOC_MEMORY_NATIVE_CAPTURE_POLICY_VERSION,
      p_authority_policy_version: XIAOC_MEMORY_NATIVE_AUTHORITY_POLICY_VERSION,
      p_idempotency_key: `native-capture-shadow-v1:${stableId}`,
    },
  }
}

export async function runXiaoCMemoryNativeCapture({
  client,
  env = process.env,
  logger = console,
  ...context
}) {
  const startedAt = Date.now()
  const correlationIdHash = buildXiaoCMemoryCorrelationHash(context.currentMessageId)
  const eligibility = validateXiaoCMemoryNativeCaptureInput(context)
  let result

  if (!isXiaoCMemoryNativeCaptureEnabled(env)) {
    result = { attempted: false, outcome: "skipped", reason_code: "FLAG_OFF" }
  } else if (!eligibility.eligible) {
    result = { attempted: false, outcome: "skipped", reason_code: eligibility.reasonCode }
  } else {
    try {
      if (!client?.rpc) throw Object.assign(new Error("NATIVE_CAPTURE_CLIENT_UNAVAILABLE"), { code: "CLIENT_UNAVAILABLE" })
      const { data, error } = await client.rpc("xiaoc_memory_capture_verified", eligibility.input)
      if (error) throw error
      result = { attempted: true, outcome: "success", captured: Boolean(data) }
    } catch (error) {
      const errorCode = String(error?.code || "NATIVE_CAPTURE_FAILED").slice(0, 80)
      logger.warn?.("XIAOC NATIVE CAPTURE SHADOW FAILED:", { error_code: errorCode })
      result = { attempted: true, outcome: "failure", error_code: errorCode }
    }
  }

  await bestEffortWriteXiaoCMemoryObservationAudit({
    client, env, logger,
    row: buildXiaoCMemoryNativeCaptureAuditRow({
      env,
      userId: context.trustedUserId,
      correlationIdHash,
      eligibleOpportunity: eligibility.eligible,
      sampled: result.attempted,
      attempted: result.attempted,
      outcome: result.outcome,
      reasonCode: result.reason_code,
      errorCode: result.error_code,
      totalLatencyMs: Date.now() - startedAt,
    }),
  })
  return result
}

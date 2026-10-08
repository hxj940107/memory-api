import {
  bestEffortWriteXiaoCMemoryObservationAudit,
  buildXiaoCMemoryCorrelationHash,
  buildXiaoCMemoryNativeCaptureAuditRow,
} from "./xiaocMemoryObservationAudit.js"
import { ensureActiveMemoryEmbedding, hashEmbeddingInput } from "./xiaocMemoryEmbedding.js"
import {
  XIAOC_MEMORY_EVIDENCE_TYPES,
  XIAOC_MEMORY_GROUNDING_POLICY_VERSION,
  XIAOC_MEMORY_TYPES,
  hasDatabaseStyleMemorySubject,
  validateXiaoCMemoryTemporal,
} from "./memoryJudge.js"

export const XIAOC_MEMORY_NATIVE_CAPTURE_POLICY_VERSION = "xiaoc-native-capture-v2"
export const XIAOC_MEMORY_NATIVE_AUTHORITY_POLICY_VERSION = "xiaoc-native-authority-v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EVIDENCE_TYPES = new Set(XIAOC_MEMORY_EVIDENCE_TYPES)
const MEMORY_TYPES = new Set(XIAOC_MEMORY_TYPES)
const NATIVE_CAPTURE_CATEGORIES = new Set([
  "personal_fact",
  "relationship_memory",
  "relationship_preference",
  "meaningful_experience",
  "long_term_concern",
])

export function isXiaoCMemoryNativeCaptureEnabled(env = process.env) {
  return env?.XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED === "true"
}

export function validateXiaoCMemoryNativeCaptureInput({
  trustedUserId,
  requestedUserId,
  currentMessageId,
  sourceMessageId,
  currentConversationId,
  sourceConversationId,
  currentMessage,
  sourceMessage,
  judgeResult,
  sourceMessages,
}) {
  if (judgeResult?.provenance_sources) {
    const sources = judgeResult.provenance_sources
    if (!Array.isArray(sources) || !sources.length || sources.length > 8
      || new Set(sources.map(source => source.source_message_id)).size !== sources.length
      || !sources.some(source => source.source_message_id === judgeResult.event_start_message_id)) {
      return { eligible: false, reasonCode: "EVENT_SOURCES_INVALID" }
    }
    const verified = sources.map(provenance => {
      const message = sourceMessages?.find(item => item.id === provenance.source_message_id)
      if (!message || message.user_id !== trustedUserId || message.role !== "user"
        || message.conversation_id !== currentConversationId || !message.created_at) {
        return { eligible: false, reasonCode: "EVENT_SOURCE_SCOPE_INVALID" }
      }
      return validateXiaoCMemoryNativeCaptureInput({ trustedUserId, requestedUserId,
        currentMessageId, sourceMessageId: message.id, currentConversationId,
        sourceConversationId: message.conversation_id, sourceMessage: message.content,
        judgeResult: { ...judgeResult, provenance_sources: undefined, provenance } })
    })
    const invalid = verified.find(item => !item.eligible)
    if (invalid) return invalid
    return { ...verified[0], multiSource: true, input: {
      p_user_id: trustedUserId, p_conversation_id: currentConversationId,
      p_event_start_message_id: judgeResult.event_start_message_id,
      p_current_message_id: currentMessageId,
      p_sources: sources, p_canonical_content: judgeResult.content.trim(),
      p_category: judgeResult.category, p_temporal: {
        event_time: verified[0].input.p_event_time,
        valid_from: verified[0].input.p_valid_from,
        valid_until: verified[0].input.p_valid_until,
      },
      p_idempotency_key: `capture-event-v1:${currentConversationId}:${judgeResult.event_start_message_id}`,
    } }
  }
  const provenance = judgeResult?.provenance || {}
  const evidenceText = String(provenance.evidence_text || "").trim()
  const evidenceType = String(provenance.evidence_type || "").trim().toLowerCase()
  const canonicalContent = String(judgeResult?.content || "").trim()
  const trustedSourceMessage = String(sourceMessage ?? currentMessage ?? "")
  const stableCurrentId = String(currentMessageId || "")
  const stableSourceId = String(sourceMessageId || "")
  const temporalResult = validateXiaoCMemoryTemporal(judgeResult?.temporal)

  if (!trustedUserId || trustedUserId !== requestedUserId) return { eligible: false, reasonCode: "OWNER_MISMATCH" }
  if (!UUID.test(stableCurrentId) || !UUID.test(stableSourceId)
    || provenance.source_message_id !== stableSourceId) {
    return { eligible: false, reasonCode: "PERSISTED_MESSAGE_REQUIRED" }
  }
  if (!currentConversationId || sourceConversationId !== currentConversationId) {
    return { eligible: false, reasonCode: "CONVERSATION_MISMATCH" }
  }
  if (!judgeResult?.save) return { eligible: false, reasonCode: "JUDGE_SAVE_REQUIRED" }
  if (!NATIVE_CAPTURE_CATEGORIES.has(judgeResult.category)) return { eligible: false, reasonCode: "CATEGORY_INVALID" }
  if (!MEMORY_TYPES.has(judgeResult.memory_type)) return { eligible: false, reasonCode: "MEMORY_TYPE_INVALID" }
  if (!canonicalContent) return { eligible: false, reasonCode: "CANONICAL_EMPTY" }
  if (hasDatabaseStyleMemorySubject(canonicalContent)) {
    return { eligible: false, reasonCode: "CANONICAL_PERSPECTIVE_INVALID" }
  }
  if (provenance.source_role !== "user") return { eligible: false, reasonCode: "SOURCE_ROLE_INVALID" }
  if (!evidenceText) return { eligible: false, reasonCode: "EVIDENCE_EMPTY" }
  if (!trustedSourceMessage.includes(evidenceText)) {
    return { eligible: false, reasonCode: "EVIDENCE_NOT_EXACT_SUBSTRING" }
  }
  if (!EVIDENCE_TYPES.has(evidenceType)) return { eligible: false, reasonCode: "EVIDENCE_TYPE_INVALID" }
  if (judgeResult?.grounding?.verified !== true
    || judgeResult?.grounding?.policy_version !== XIAOC_MEMORY_GROUNDING_POLICY_VERSION) {
    return { eligible: false, reasonCode: "GROUNDING_NOT_VERIFIED" }
  }
  if (!temporalResult.valid) return { eligible: false, reasonCode: temporalResult.reason.toUpperCase() }

  return {
    eligible: true,
    reasonCode: null,
    contentHash: hashEmbeddingInput(canonicalContent),
    input: {
      p_user_id: trustedUserId,
      p_source_message_id: stableSourceId,
      p_source_conversation_id: sourceConversationId,
      p_evidence_text: evidenceText,
      p_evidence_type: evidenceType,
      p_canonical_content: canonicalContent,
      p_memory_class: "observation",
      p_category: judgeResult.category,
      p_claim_key: null,
      p_event_time: temporalResult.temporal.event_time,
      p_valid_from: temporalResult.temporal.valid_from,
      p_valid_until: temporalResult.temporal.valid_until,
      p_importance: null,
      p_confidence: null,
      p_capture_policy_version: XIAOC_MEMORY_NATIVE_CAPTURE_POLICY_VERSION,
      p_authority_policy_version: XIAOC_MEMORY_NATIVE_AUTHORITY_POLICY_VERSION,
      p_idempotency_key: `native-capture-v2:${stableCurrentId}:${stableSourceId}`,
    },
  }
}

async function findExactActiveDuplicate(client, { userId, contentHash }) {
  if (!client?.from) return null
  const table = client.from("memory_items")
  if (!table?.select) return null
  const { data, error } = await table
    .select("id")
    .eq("user_id", userId)
    .eq("lifecycle_status", "active")
    .eq("content_hash", contentHash)
    .eq("authority_tier", "native_verified")
    .limit(1)
    .maybeSingle()
  if (error) {
    const failure = new Error("NATIVE_CAPTURE_DEDUPE_FAILED")
    failure.code = String(error.code || "DEDUPE_CHECK_FAILED")
    throw failure
  }
  return data?.id || null
}

export async function runXiaoCMemoryNativeCapture({
  client,
  env = process.env,
  logger = console,
  embeddingProvider = null,
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
      const duplicateMemoryId = eligibility.multiSource ? null : await findExactActiveDuplicate(client, {
        userId: context.trustedUserId,
        contentHash: eligibility.contentHash,
      })
      if (duplicateMemoryId) {
        result = {
          attempted: false,
          outcome: "duplicate",
          reason_code: "EXACT_ACTIVE_CONTENT",
          memory_id: duplicateMemoryId,
        }
      } else {
        if (!client?.rpc) throw Object.assign(new Error("NATIVE_CAPTURE_CLIENT_UNAVAILABLE"), { code: "CLIENT_UNAVAILABLE" })
        const { data, error } = await client.rpc(
          eligibility.multiSource ? "xiaoc_memory_capture_event_verified" : "xiaoc_memory_capture_verified",
          eligibility.input,
        )
        if (error) throw error
        result = { attempted: true, outcome: "success", captured: Boolean(data), memory_id: data || null }
        if (data && embeddingProvider) {
          try {
            await ensureActiveMemoryEmbedding({ client, provider: embeddingProvider, logger, memory: {
              id: data,
              user_id: context.trustedUserId,
              canonical_content: eligibility.input.p_canonical_content,
              content_hash: eligibility.contentHash,
            } })
            result.embedding = "active"
          } catch (error) {
            result.embedding = "failed"
            result.embedding_error_code = String(error?.code || error?.message || "EMBEDDING_FAILED").split(":")[0].slice(0, 80)
            logger.warn?.("XIAOC NATIVE EMBEDDING FAILED:", { memory_id: data, error_code: result.embedding_error_code })
          }
        }
      }
    } catch (error) {
      const errorCode = String(error?.code || "NATIVE_CAPTURE_FAILED").slice(0, 80)
      logger.warn?.("XIAOC NATIVE CAPTURE FAILED:", { error_code: errorCode })
      result = { attempted: true, outcome: "failure", error_code: errorCode }
    }
  }

  const memoryTypeCode = String(context.judgeResult?.memory_type || "UNSPECIFIED")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 32)
  const auditReason = result.outcome === "success"
    ? `PERSISTED_${memoryTypeCode}`
    : result.outcome === "duplicate"
      ? `DEDUPED_EXACT_ACTIVE_${memoryTypeCode}`.slice(0, 80)
      : result.outcome === "failure"
        ? `PERSIST_FAILED_${memoryTypeCode}`.slice(0, 80)
      : result.reason_code === "FLAG_OFF"
        ? `FLAG_OFF_${memoryTypeCode}`.slice(0, 80)
      : result.reason_code
          ? `VALIDATION_${result.reason_code}_${memoryTypeCode}`.slice(0, 80)
          : null
  await bestEffortWriteXiaoCMemoryObservationAudit({
    client,
    env,
    logger,
    row: buildXiaoCMemoryNativeCaptureAuditRow({
      env,
      userId: context.trustedUserId,
      correlationIdHash,
      eligibleOpportunity: true,
      sampled: true,
      attempted: result.attempted,
      outcome: result.outcome,
      reasonCode: auditReason,
      errorCode: result.error_code,
      totalLatencyMs: Date.now() - startedAt,
    }),
  })
  return result
}

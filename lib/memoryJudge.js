import { AI_ENDPOINTS, AI_MODELS } from "./aiConfig.js"
import { normalizeAssistantOutput } from "./assistantOutput.js"
import { buildPromptCacheUsageLog } from "./promptCaching.js"

export const XIAOC_MEMORY_GROUNDING_POLICY_VERSION = "xiaoc-memory-grounding-v1"

const SAVE_CATEGORIES = new Set([
  "personal_fact",
  "relationship_memory",
  "relationship_preference",
  "meaningful_experience",
  "long_term_concern",
])

export const XIAOC_MEMORY_TYPES = Object.freeze([
  "stable_fact",
  "preference",
  "correction",
  "temporal_plan",
  "relationship_milestone",
  "meaningful_experience",
  "long_term_concern",
])

const SAVE_MEMORY_TYPES = new Set(XIAOC_MEMORY_TYPES)

export const XIAOC_MEMORY_EVIDENCE_TYPES = Object.freeze([
  "assertion",
  "confirmation",
  "correction",
  "question",
  "other",
])

const USER_EVIDENCE_TYPES = new Set(XIAOC_MEMORY_EVIDENCE_TYPES)

export const XIAOC_MEMORY_VALIDATION_REASONS = Object.freeze([
  "source_role_invalid",
  "source_message_not_allowed",
  "evidence_empty",
  "evidence_not_exact_substring",
  "evidence_type_invalid",
  "category_invalid",
  "memory_type_invalid",
  "canonical_empty",
  "temporal_format_invalid",
  "temporal_range_invalid",
])

const MEMORY_VALIDATION_REASON_SET = new Set(XIAOC_MEMORY_VALIDATION_REASONS)

export function isMemoryJudgeValidationRejectionReason(reason) {
  return MEMORY_VALIDATION_REASON_SET.has(String(reason || ""))
}

function extractJson(text) {
  const clean = String(text || "")
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim()
  const jsonStart = clean.indexOf("{")
  const jsonEnd = clean.lastIndexOf("}")
  if (jsonStart < 0 || jsonEnd < jsonStart) return null
  return clean.slice(jsonStart, jsonEnd + 1)
}

function normalizeUserSources(sources) {
  return (Array.isArray(sources) ? sources : [])
    .filter(source => source?.role === "user" && source?.id && source?.content)
    .map(source => ({ id: String(source.id), role: "user", content: String(source.content) }))
}

function inferredMemoryType(category, evidenceType) {
  if (evidenceType === "correction") return "correction"
  if (category === "relationship_preference") return "preference"
  if (category === "relationship_memory") return "relationship_milestone"
  if (category === "meaningful_experience") return "meaningful_experience"
  if (category === "long_term_concern") return "long_term_concern"
  return "stable_fact"
}

function normalizeIsoTimestamp(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return { value: null, reason: null }
  }
  const text = String(value).trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    return { value: null, reason: "temporal_format_invalid" }
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed)
    ? { value: new Date(parsed).toISOString(), reason: null }
    : { value: null, reason: "temporal_format_invalid" }
}

export function validateXiaoCMemoryTemporal(value) {
  if (value !== null && value !== undefined && typeof value !== "object") {
    return { valid: false, reason: "temporal_format_invalid", temporal: null }
  }
  const raw = value && typeof value === "object" ? value : {}
  const eventTime = normalizeIsoTimestamp(raw.event_time)
  const validFrom = normalizeIsoTimestamp(raw.valid_from)
  const validUntil = normalizeIsoTimestamp(raw.valid_until)
  if ([eventTime, validFrom, validUntil].some(item => item.reason)) {
    return { valid: false, reason: "temporal_format_invalid", temporal: null }
  }
  const temporal = {
    event_time: eventTime.value,
    valid_from: validFrom.value,
    valid_until: validUntil.value,
  }
  if (temporal.valid_from && temporal.valid_until
    && Date.parse(temporal.valid_until) < Date.parse(temporal.valid_from)) {
    return { valid: false, reason: "temporal_range_invalid", temporal: null }
  }
  return { valid: true, reason: null, temporal }
}

export function validateUserMemoryProvenance(result, allowedUserSources = []) {
  if (!result?.save) {
    return {
      save: false,
      category: String(result?.category || "").trim(),
      content: "",
      provenance: null,
      memory_type: "none",
      temporal: { event_time: null, valid_from: null, valid_until: null },
      reason: null,
    }
  }

  const sourceRole = String(result.source_role || "").trim().toLowerCase()
  const sourceMessageId = String(result.source_message_id || "").trim()
  const evidenceText = String(result.evidence_text || "").trim()
  const evidenceType = String(result.evidence_type || "").trim().toLowerCase()
  const category = String(result.category || "").trim()
  const content = String(result.content || "").trim()
  const requestedMemoryType = String(result.memory_type || "").trim().toLowerCase()
  const memoryType = requestedMemoryType || inferredMemoryType(category, evidenceType)
  const temporalResult = validateXiaoCMemoryTemporal(result.temporal)
  const source = normalizeUserSources(allowedUserSources).find(item => item.id === sourceMessageId)

  const rejectionReason = sourceRole !== "user" ? "source_role_invalid"
    : !source ? "source_message_not_allowed"
      : !evidenceText ? "evidence_empty"
        : !source.content.includes(evidenceText) ? "evidence_not_exact_substring"
          : !USER_EVIDENCE_TYPES.has(evidenceType) ? "evidence_type_invalid"
            : !SAVE_CATEGORIES.has(category) ? "category_invalid"
              : !SAVE_MEMORY_TYPES.has(memoryType) ? "memory_type_invalid"
                : !content ? "canonical_empty"
                  : !temporalResult.valid ? temporalResult.reason
                    : null

  if (rejectionReason) {
    return {
      save: false,
      category,
      content: "",
      provenance: null,
      memory_type: memoryType,
      temporal: { event_time: null, valid_from: null, valid_until: null },
      reason: rejectionReason,
    }
  }

  return {
    save: true,
    category,
    content,
    memory_type: memoryType,
    temporal: temporalResult.temporal,
    provenance: {
      source_role: "user",
      source_message_id: source.id,
      evidence_text: evidenceText,
      evidence_type: evidenceType,
    },
    reason: null,
  }
}

export function validateCanonicalGroundingDecision(result) {
  const supported = result?.supported === true
  const reasonCode = String(result?.reason_code || "").trim().toUpperCase()
  if (supported && reasonCode === "SUPPORTED") return { supported: true, reason_code: "SUPPORTED" }
  const allowedRejectReasons = new Set([
    "UNSUPPORTED_FACT",
    "UNSUPPORTED_TEMPORAL",
    "AMBIGUOUS_ATTRIBUTION",
    "OVERGENERALIZED",
  ])
  return {
    supported: false,
    reason_code: allowedRejectReasons.has(reasonCode) ? reasonCode : "GROUNDING_INVALID_OUTPUT",
  }
}

async function requestMemoryJson({ prompt, maxTokens, purpose, fetchImpl = globalThis.fetch }) {
  const startedAt = Date.now()
  const response = await fetchImpl(AI_ENDPOINTS.openRouterChatCompletions, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODELS.memoryJudge,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
    }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(data?.error?.message || `${purpose} failed`)
    error.code = purpose === "memory_grounding" ? "MEMORY_GROUNDING_FAILED" : "MEMORY_JUDGE_FAILED"
    throw error
  }
  const text = normalizeAssistantOutput(data?.choices?.[0]?.message)
  const jsonText = extractJson(text)
  let parsed
  try {
    parsed = JSON.parse(jsonText || "")
  } catch {
    const error = new Error(`${purpose} invalid output`)
    error.code = purpose === "memory_grounding" ? "MEMORY_GROUNDING_PARSE_ERROR" : "MEMORY_JUDGE_PARSE_ERROR"
    throw error
  }
  console.log("AI TASK USAGE:", {
    task: purpose === "memory_grounding" ? "memory-grounding" : "memory-check",
    request_purpose: purpose,
    model: AI_MODELS.memoryJudge,
    inputMessages: 1,
    inputChars: prompt.length,
    maxTokens,
    success: true,
    ...buildPromptCacheUsageLog(data?.usage),
    durationMs: Date.now() - startedAt,
  })
  return parsed
}

export function buildMemoryJudgePrompt({
  message,
  previousContent = "",
  assistantContext = "",
  allowedUserSources = [],
  referenceTime = new Date().toISOString(),
}) {
  return `
你是“小C”的长期记忆判断器。你负责判断语义价值，不是关键词过滤器。

核心问题：如果小C在未来合适的对话中仍然知道这件事，是否会明显改善她对用户、双方关系、持续事项或未来跟进的理解？

save=true 通常只用于：
- stable_fact：稳定的用户事实
- preference：长期偏好、边界或相处方式
- correction：用户对已有认识的明确修正
- temporal_plan：对用户本人有连续性价值的未来计划
- relationship_milestone：用户与小C之间值得长期保留的关系事件
- meaningful_experience：重要经历
- long_term_concern：长期困扰或持续关注

以下通常 save=false：
- transient_state：纯瞬时状态或互动情绪
- turn_only_instruction：只影响当前操作的指令
- third_party_trivia：与用户本人、双方关系或持续事项无明显长期价值的第三方闲聊
- low_continuity_value：未来知道也不会改善陪伴连续性的普通闲聊
- 单次项目开发、UI 调试、部署、测试或错误状态

不要因为句子很短就拒绝。不要因为出现未来时态就拒绝。也不要为了提高召回而保存所有聊天。

只允许把 user source ledger 中的用户原话作为事实来源。assistant 回复只能帮助理解语境，不能提供新事实。
evidence_text 必须是对应 user message 中真实、连续、非空的原文子串。
canonical content 可以忠实改写、压缩、调整语序或把“我”规范为“她”，但不得增加 evidence 没有支持的事实。

时间规则：
- 当前参考时间：${referenceTime}，时区 Asia/Shanghai。
- 只有来源提供足够明确的时间信息时，才填写 temporal 字段。
- temporal 值只能是带时区的 ISO-8601 timestamp；不能可靠确定时必须为 null。
- 未来计划的发生时间写入 event_time；不要把计划发生时间误写成 valid_from。
- valid_from / valid_until 只表示 evidence 明确支持的有效区间。
- canonical content 必须保留对未来理解有影响的时间信息，不能只把时间放在 metadata。
- 不得为了填字段猜测日期。

save=true 时只返回：
{
  "save": true,
  "category": "personal_fact | relationship_memory | relationship_preference | meaningful_experience | long_term_concern",
  "memory_type": "stable_fact | preference | correction | temporal_plan | relationship_milestone | meaningful_experience | long_term_concern",
  "content": "小C应长期记住的自然 canonical memory",
  "source_role": "user",
  "source_message_id": "真实 user message id",
  "evidence_text": "该 user message 中直接支持记忆的连续原文",
  "evidence_type": "assertion | confirmation | correction",
  "temporal": { "event_time": null, "valid_from": null, "valid_until": null }
}

save=false 时只返回：
{
  "save": false,
  "category": "project_dev | temporary_test | assistant_output | casual_chat | short_term | not_long_term",
  "memory_type": "none",
  "content": ""
}

当前用户消息：
${message}

允许的 user source ledger：
${JSON.stringify(allowedUserSources)}

上一条用户消息：
${previousContent}

本轮小C回复（仅用于语境，不是事实来源）：
${assistantContext}
`
}

export async function verifyCanonicalGrounding(candidate, options = {}) {
  const prompt = `
你是长期记忆 grounding verifier。只判断 canonical memory 中的每一个具体事实是否都由用户 evidence 直接支持。

允许：忠实改写、压缩、语序调整、把用户自称“我”改成“她”、把对小C的“你”改成“小C/我”。
拒绝：新增事实、扩大范围、把临时状态说成长期规律、错误归属、无证据的精确时间。
不要输出解释或推理，只返回 JSON：
{"supported":true,"reason_code":"SUPPORTED"}
或
{"supported":false,"reason_code":"UNSUPPORTED_FACT | UNSUPPORTED_TEMPORAL | AMBIGUOUS_ATTRIBUTION | OVERGENERALIZED"}

memory_type: ${candidate.memory_type}
canonical_content: ${candidate.content}
evidence_text: ${candidate.provenance.evidence_text}
evidence_type: ${candidate.provenance.evidence_type}
temporal: ${JSON.stringify(candidate.temporal)}
`
  const raw = await requestMemoryJson({
    prompt,
    maxTokens: 80,
    purpose: "memory_grounding",
    fetchImpl: options.fetchImpl,
  })
  return validateCanonicalGroundingDecision(raw)
}

export async function judgeMemory(message, options = {}) {
  const allowedUserSources = normalizeUserSources(options.allowedUserSources)
  const prompt = buildMemoryJudgePrompt({
    message,
    previousContent: options.previousContent || "",
    assistantContext: options.assistantContext || "",
    allowedUserSources,
    referenceTime: options.referenceTime || new Date().toISOString(),
  })

  try {
    const raw = await requestMemoryJson({
      prompt,
      maxTokens: 420,
      purpose: "memory_judge",
      fetchImpl: options.fetchImpl,
    })
    const modelSave = raw?.save === true
    const candidate = validateUserMemoryProvenance(raw, allowedUserSources)
    if (!candidate.save) return { ...candidate, model_save: modelSave }

    const verification = options.groundingVerifier
      ? validateCanonicalGroundingDecision(await options.groundingVerifier(candidate))
      : await verifyCanonicalGrounding(candidate, { fetchImpl: options.fetchImpl })
    if (!verification.supported) {
      return {
        save: false,
        category: candidate.category,
        content: "",
        provenance: null,
        memory_type: candidate.memory_type,
        temporal: candidate.temporal,
        reason: "unsupported_canonical",
        validation_reason: verification.reason_code,
        model_save: modelSave,
      }
    }
    return {
      ...candidate,
      grounding: { verified: true, policy_version: XIAOC_MEMORY_GROUNDING_POLICY_VERSION },
      model_save: modelSave,
    }
  } catch (error) {
    console.error("AI TASK FAILED:", {
      task: "memory-check",
      model: AI_MODELS.memoryJudge,
      inputMessages: 1,
      inputChars: prompt.length,
      success: false,
      error_code: String(error?.code || "MEMORY_JUDGE_FAILED").slice(0, 80),
    })
    throw error
  }
}

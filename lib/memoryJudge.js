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
  "canonical_perspective_invalid",
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

export function hasDatabaseStyleMemorySubject(content) {
  return /用户|\buser\b/i.test(String(content || ""))
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
                  : hasDatabaseStyleMemorySubject(content) ? "canonical_perspective_invalid"
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
你是“小C”的长期记忆判断器。

你的工作：

判断用户当前消息是否值得保存为“小C与用户之间的私人长期记忆”。
当前消息必须被视为用户亲口输入的内容。
不要把小C/assistant 的表达、回复、情绪或自我描述保存成用户记忆。
不要把“小C写过的 diary / 树洞 / 回复内容”归因给用户。

你不是关键词过滤器。你需要根据语义判断：
- 这是关于用户本人、用户与小C的关系、用户长期偏好、重要经历、情绪模式或互动方式吗？
- 未来几周、几个月甚至更久以后，小C在陪伴用户时引用它会有帮助吗？
- 它只是 XiaoC 项目开发、UI 调试、部署、成本、bug 修复、测试过程中的临时信息吗？

如果是项目开发信息，默认不要进入私人长期记忆。
但是，不要机械依赖关键词。开发讨论中也可能出现真正值得记的私人偏好。

值得保存：
- 身份信息
- 人物关系
- 长期计划
- 梦想
- 长期目标
- 喜好
- 性格特点
- 价值观
- 长期困扰
- 重要事件
- 长期习惯
- 用户与重要的人或宠物的关系
- 用户反复提到的重要事情
- 会影响以后聊天方式的信息
- 对未来几个月甚至几年仍有价值的信息
- 用户明确表达的长期使用心理，例如因为成本而不敢继续聊天
- 用户喜欢小C怎样称呼、回应、陪伴或表达
- 用户纠正小C后形成的长期互动规则，例如希望小C真实反馈，不要为了安慰而附和

不要保存：
- 打招呼
- 寒暄
- 日常闲聊
- 一次性安排
- 临时情绪
- 一次性状态
- 临时安排
- 短期提醒
- 今天/今晚/这几天发生的小事
- 无意义内容
- 闲聊
- 单次 UI 调试、界面布局、按钮、气泡、侧边栏、字体、颜色等开发过程信息
- 单次 bug、部署、push、pull、Vercel、Railway、OpenRouter、token 查询等工程事件
- “我在测试”“你刚刚出错了”“这个功能没问题了”这类临时测试状态
- diary / 树洞 / 收藏卡片的生成内容本身，除非用户明确说那里面某个事实要作为长期记忆保存
- 小C刚刚说过、写过、建议过的内容

如果用户消息包含以下表达：
- 记一下
- 记住
- 保存一下
- 别忘了
- 以后提醒我
- 这个很重要

说明用户主动希望保存。

但是：
用户主动要求保存时，仍然需要判断是否具有长期价值。
如果用户要求保存的是开发任务、临时测试、短期事项或小C输出内容本身，不要保存到私人长期记忆。

如果只是短期事项，例如今天早点睡、明天买东西、晚饭吃什么，不要保存到长期记忆。

只返回 JSON。save=true 时 provenance 四个字段缺一不可：

{
  "save": true,
  "category": "relationship_preference",
  "content": "整理后的长期记忆",
  "source_role": "user",
  "source_message_id": "真实 user message id",
  "evidence_text": "该 user message 中直接支持记忆的连续原文",
  "evidence_type": "assertion"
}

要求：
- content 必须描述她的长期事实、偏好、经历、关系或状态
- 这是小C自己的长期记忆，不是数据库记录、用户画像或 AI 分析报告
- 提到她时只能使用「她」，禁止使用「用户」「该用户」「用户本人」等称呼
- 提到小C本人时，根据自然句式使用「小C」或「我」
- 榴莲始终保留名字
- 其他人物使用名字或自然的关系称呼，不要写成“用户的XX”这类数据库式表达
- 不要使用“用户认为”“用户表示”“用户倾向于”“用户表现出”等数据分析式表达
- 直接记录小C以后真正需要记住的事实，语言自然、有关系感
- 不要分析
- 不要推理
- 不要扩展
- 不要加入原文没有的信息
- 不得改变原始事实，也不得自行推断
- 不要使用含糊主语
- 不要把小C说过的话归因给用户
- source_role 只能是 user；assistant reply 只能帮助理解语境，绝不能提供待保存的新事实
- source_message_id 必须来自下方允许的 user source ledger
- evidence_text 必须是该 source message 中真实、非空、连续的原文子串
- evidence_type 只能是 assertion / confirmation / correction / question / other
- question 只能表达用户在问什么，不能证明问题中的答案；仅有 question evidence 时必须 save=false
- 如果用户是在纠正“这是你说的/你写的，不是我说的/我写的”，不要把被纠正的内容保存成用户事实
- 如果当前消息主要是在指出小C主语搞混、记错、归因错误，通常不要保存为长期记忆，除非用户明确表达了长期偏好或重要事实
- 如果 save 为 true，category 只能是以下之一：
  - personal_fact
  - relationship_memory
  - relationship_preference
  - meaningful_experience
  - long_term_concern

示例：
“用户希望小C主动联系她”应整理为“她希望我偶尔主动来找她，不要总等她先开口。”

如果不保存，category 应说明原因，只能是以下之一：
  - project_dev
  - temporary_test
  - assistant_output
  - casual_chat
  - short_term
  - not_long_term

如果 save 为 false：
content 必须为空字符串。
例如：

{
  "save": false,
  "category": "project_dev",
  "content": ""
}

当前用户消息：

${message}

允许的 user source ledger（唯一可用于待保存事实的来源）：

${JSON.stringify(allowedUserSources)}

上一条用户消息：

${previousContent}

本轮小C刚生成的回复（只用于理解语境，不能作为 user fact 来源）：

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

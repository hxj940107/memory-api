import { estimateTextTokens } from "./dynamicContextBudget.js"

export const SHARED_CONTEXT_KINDS = Object.freeze([
  "reading", "article", "project", "discussion", "other",
])
export const SHARED_CONTEXT_STATUSES = Object.freeze(["active", "archived"])
export const SHARED_CONTEXT_SOURCE_LIMIT = 40
export const SHARED_CONTEXT_UPDATE_TURN_THRESHOLD = 6
const SHARED_CONTEXT_FIELDS = [
  "progress", "recent_decisions", "user_views", "xiaoc_views", "open_questions", "latest_update",
]

function compactText(value, maxChars) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxChars)
}

function compactList(value, { maxItems = 6, maxChars = 180 } = {}) {
  const items = Array.isArray(value) ? value : []
  return [...new Set(items.map(item => compactText(item, maxChars)).filter(Boolean))]
    .slice(-maxItems)
}

export function emptySharedWorkingContext() {
  return {
    progress: null,
    recent_decisions: [],
    user_views: [],
    xiaoc_views: [],
    open_questions: [],
    latest_update: null,
    source_message_ids: [],
    field_sources: Object.fromEntries(SHARED_CONTEXT_FIELDS.map(field => [field, []])),
    conversation_checkpoints: {},
  }
}

export function normalizeSharedWorkingContext(value) {
  const fieldSources = Object.fromEntries(SHARED_CONTEXT_FIELDS.map(field => [
    field,
    [...new Set(
      (Array.isArray(value?.field_sources?.[field]) ? value.field_sources[field] : [])
        .map(item => compactText(item, 120))
        .filter(Boolean)
    )].slice(-12),
  ]))
  return {
    progress: compactText(value?.progress, 240) || null,
    recent_decisions: compactList(value?.recent_decisions),
    user_views: compactList(value?.user_views),
    xiaoc_views: compactList(value?.xiaoc_views),
    open_questions: compactList(value?.open_questions),
    latest_update: compactText(value?.latest_update, 240) || null,
    source_message_ids: [...new Set(
      (Array.isArray(value?.source_message_ids) ? value.source_message_ids : [])
        .map(item => compactText(item, 120))
        .filter(Boolean)
    )].slice(-SHARED_CONTEXT_SOURCE_LIMIT),
    field_sources: fieldSources,
    conversation_checkpoints: Object.fromEntries(
      Object.entries(value?.conversation_checkpoints || {})
        .map(([conversationId, messageId]) => [
          compactText(conversationId, 160),
          compactText(messageId, 120),
        ])
        .filter(([conversationId, messageId]) => conversationId && messageId)
        .slice(-20)
    ),
  }
}

export function normalizeSharedContext(value) {
  const id = compactText(value?.id, 120)
  const title = compactText(value?.title, 120)
  if (!id || !title) return null
  return {
    id,
    title,
    kind: SHARED_CONTEXT_KINDS.includes(value?.kind) ? value.kind : "other",
    status: SHARED_CONTEXT_STATUSES.includes(value?.status) ? value.status : "active",
    working_context: normalizeSharedWorkingContext(value?.working_context),
    created_at: value?.created_at || null,
    updated_at: value?.updated_at || null,
  }
}

export function formatSharedContextForPrompt(value, maxChars = 1500) {
  const context = normalizeSharedContext(value)
  if (!context || context.status !== "active") return ""
  const working = context.working_context
  const lines = [
    `Title: ${context.title}`,
    `Type: ${context.kind}`,
    working.progress && `Progress: ${working.progress}`,
    working.recent_decisions.length && `Recent decisions: ${working.recent_decisions.join("；")}`,
    working.user_views.length && `她的观点: ${working.user_views.join("；")}`,
    working.xiaoc_views.length && `小C此前的观点: ${working.xiaoc_views.join("；")}`,
    working.open_questions.length && `Open questions: ${working.open_questions.join("；")}`,
    working.latest_update && `Latest update: ${working.latest_update}`,
  ].filter(Boolean)
  return `【Shared Context｜我们明确共同进行的持续对象】\n这是当前 conversation 由她显式打开的共同空间。自然延续即可，不要逐项复述，也不要把其中内容自动变成 Memory、提醒或 proactive event。\n${lines.join("\n")}`
    .slice(0, maxChars)
}

export function getSharedContextDiagnostics(value, { injected = false, update = null } = {}) {
  const context = normalizeSharedContext(value)
  const prompt = injected ? formatSharedContextForPrompt(context) : ""
  return {
    bound: Boolean(context),
    id: context?.id || null,
    kind: context?.kind || null,
    injected: Boolean(context && injected),
    estimated_tokens: estimateTextTokens(prompt),
    update_triggered: Boolean(update?.triggered),
    update_reason: update?.reason || null,
    update_llm_called: Boolean(update?.llmCalled),
    source_message_count: context?.working_context.source_message_ids.length || 0,
  }
}

export function selectPendingSharedContextMessages(messages, workingContext, conversationId = null) {
  const normalized = normalizeSharedWorkingContext(workingContext)
  const eligible = (messages || []).filter(message => (
    message?.id
    && ["user", "assistant"].includes(message.role)
  ))
  const checkpoint = conversationId
    ? normalized.conversation_checkpoints[conversationId]
    : null
  if (!checkpoint) return eligible
  const checkpointIndex = eligible.findIndex(item => String(item.id) === checkpoint)
  return checkpointIndex >= 0 ? eligible.slice(checkpointIndex + 1) : eligible
}

export function shouldUpdateSharedContext(messages, { force = false } = {}) {
  const userTurns = (messages || []).filter(item => item.role === "user").length
  return {
    shouldUpdate: Boolean(messages?.length && (force || userTurns >= SHARED_CONTEXT_UPDATE_TURN_THRESHOLD)),
    reason: force && messages?.length
      ? "explicit_flush"
      : userTurns >= SHARED_CONTEXT_UPDATE_TURN_THRESHOLD
        ? "related_turn_threshold"
        : "debounced",
    userTurns,
  }
}

export function buildSharedContextUpdatePrompt(context, messages) {
  const normalized = normalizeSharedContext(context)
  const evidence = (messages || []).map(item => ({
    id: String(item.id),
    role: item.role,
    content: compactText(item.content, 800),
  }))
  return `只输出 JSON。根据真实消息证据更新这个 Shared Context 的 working_context。\n\n当前对象：${JSON.stringify(normalized)}\n\n新增消息：${JSON.stringify(evidence)}\n\n输出：{"progress":null,"recent_decisions":[],"user_views":[],"xiaoc_views":[],"open_questions":[],"latest_update":null,"field_sources":{"progress":[],"recent_decisions":[],"user_views":[],"xiaoc_views":[],"open_questions":[],"latest_update":[]}}\n\n规则：保留仍有效的旧内容并合并新内容；每个非空字段必须在 field_sources 对应数组列出直接支持它的真实消息 ID；user_views 的新证据只能来自 role=user；xiaoc_views 的新证据只能来自 role=assistant；决定、进度和问题必须有消息证据；不得猜测。列表保持精简，每类最多6项。`
}

export function parseSharedContextUpdate(raw, previous, allowedMessages, conversationId = null) {
  let parsed
  try {
    const match = String(raw || "").match(/\{[\s\S]*\}/)
    parsed = JSON.parse(match?.[0] || "")
  } catch {
    return null
  }
  const allowedIds = new Set((allowedMessages || []).map(item => String(item.id)))
  const previousNormalized = normalizeSharedWorkingContext(previous)
  const priorIds = new Set(previousNormalized.source_message_ids)
  const roleById = new Map((allowedMessages || []).map(item => [String(item.id), item.role]))
  const update = normalizeSharedWorkingContext(parsed)
  for (const field of SHARED_CONTEXT_FIELDS) {
    const hasContent = Array.isArray(update[field]) ? update[field].length > 0 : Boolean(update[field])
    const sources = update.field_sources[field]
    if (hasContent && !sources.length) return null
    if (sources.some(id => !allowedIds.has(id) && !priorIds.has(id))) return null
  }
  if (update.field_sources.user_views.some(id => (
    allowedIds.has(id) && roleById.get(id) !== "user"
  ))) return null
  if (update.field_sources.xiaoc_views.some(id => (
    allowedIds.has(id) && roleById.get(id) !== "assistant"
  ))) return null
  const referencedIds = [...new Set(SHARED_CONTEXT_FIELDS.flatMap(
    field => update.field_sources[field]
  ))]
  return normalizeSharedWorkingContext({
    ...update,
    source_message_ids: [
      ...previousNormalized.source_message_ids,
      ...referencedIds,
    ],
    conversation_checkpoints: {
      ...previousNormalized.conversation_checkpoints,
      ...(conversationId && allowedMessages?.at(-1)?.id
        ? { [conversationId]: String(allowedMessages.at(-1).id) }
        : {}),
    },
  })
}

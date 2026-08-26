export const ACTIVE_CONTEXT_MAX_ITEMS = 4
export const ACTIVE_CONTEXT_MAX_CHARS = 420
export const ACTIVE_CONTEXT_TRANSIENT_MAX_MISSED_TURNS = 3

function compactText(value, maxChars) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxChars)
}

function inferKind(rawItem) {
  if (["transient", "plan", "waiting", "unresolved"].includes(rawItem?.kind)) {
    return rawItem.kind
  }

  const text = `${rawItem?.topic || ""} ${rawItem?.context || ""}`
  if (rawItem?.status === "waiting" || /等待|等结果|等回复|待确认/.test(text)) {
    return "waiting"
  }
  if (/计划|准备|打算|之后|明天|后天|周[一二三四五六日天]|要去|预约|考试|面试|复查/.test(text)) {
    return "plan"
  }
  if (/未解决|还没|仍在|继续处理|需要处理|正在处理/.test(text)) {
    return "unresolved"
  }
  return "transient"
}

export function normalizeActiveConversationContext(value) {
  if (!value || !Array.isArray(value.items)) return null

  const items = []
  let usedChars = 0

  for (const rawItem of value.items) {
    if (items.length >= ACTIVE_CONTEXT_MAX_ITEMS) break

    const topic = compactText(rawItem?.topic, 60)
    const context = compactText(rawItem?.context, 180)
    if (!topic || !context) continue

    const remaining = ACTIVE_CONTEXT_MAX_CHARS - usedChars - topic.length
    if (remaining <= 0) break

    const normalizedContext = context.slice(0, remaining)
    if (!normalizedContext) break

    const kind = inferKind(rawItem)
    items.push({
      topic,
      context: normalizedContext,
      status: ["active", "waiting", "resolved"].includes(rawItem?.status)
        ? rawItem.status
        : "active",
      kind,
      source_message_id: compactText(rawItem?.source_message_id, 120) || null,
      last_referenced_message_id:
        compactText(rawItem?.last_referenced_message_id, 120)
        || compactText(rawItem?.source_message_id, 120)
        || null,
      missed_turns: Math.max(0, Math.min(99, Number(rawItem?.missed_turns) || 0)),
    })
    usedChars += topic.length + normalizedContext.length
  }

  return { items }
}

export function resolveActiveConversationContext(
  previous,
  candidate,
  { currentMessageId = null } = {}
) {
  const normalizedPrevious = normalizeActiveConversationContext(previous)
  const normalizedCandidate = normalizeActiveConversationContext(candidate)

  if (!normalizedCandidate) return normalizedPrevious ?? { items: [] }

  const previousBySource = new Map(
    (normalizedPrevious?.items || []).map(item => [
      item.source_message_id || item.topic,
      item,
    ])
  )

  const items = normalizedCandidate.items
    .filter(item => item.status !== "resolved")
    .map(item => {
      const previousItem = previousBySource.get(item.source_message_id || item.topic)
      const explicitlyReferenced = Boolean(
        currentMessageId
        && item.last_referenced_message_id === currentMessageId
      )
      const missedTurns = explicitlyReferenced
        ? 0
        : Math.min(99, (previousItem?.missed_turns || 0) + 1)

      return { ...item, missed_turns: missedTurns }
    })
    .filter(item => (
      item.kind !== "transient"
      || item.missed_turns < ACTIVE_CONTEXT_TRANSIENT_MAX_MISSED_TURNS
    ))

  return normalizeActiveConversationContext({ items }) ?? { items: [] }
}

export function formatActiveConversationContext(context, { recentMessageIds = [] } = {}) {
  const normalized = normalizeActiveConversationContext(context)
  const recentIds = new Set(recentMessageIds.filter(Boolean))
  const visibleItems = (normalized?.items || []).filter(item => (
    !item.source_message_id || !recentIds.has(item.source_message_id)
  ))
  if (!visibleItems.length) return ""

  const lines = visibleItems.map(item =>
    `- ${item.topic}：${item.context}`
  )

  return `【Active Conversation Context｜当前仍有效的短期上下文】
这些事项只是帮助你自然保持连续性。仅在当前对话合适时使用，不要逐条复述，不要为了证明记得而主动全部提起，也不要把它们当成 checklist。

${lines.join("\n")}`
}

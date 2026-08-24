export const ACTIVE_CONTEXT_MAX_ITEMS = 4
export const ACTIVE_CONTEXT_MAX_CHARS = 420

function compactText(value, maxChars) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxChars)
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

    items.push({
      topic,
      context: normalizedContext,
      status: ["active", "waiting"].includes(rawItem?.status)
        ? rawItem.status
        : "active",
      source_message_id: compactText(rawItem?.source_message_id, 120) || null,
    })
    usedChars += topic.length + normalizedContext.length
  }

  return { items }
}

export function resolveActiveConversationContext(previous, candidate) {
  return normalizeActiveConversationContext(candidate)
    ?? normalizeActiveConversationContext(previous)
    ?? { items: [] }
}

export function formatActiveConversationContext(context) {
  const normalized = normalizeActiveConversationContext(context)
  if (!normalized?.items.length) return ""

  const lines = normalized.items.map(item =>
    `- ${item.topic}：${item.context}`
  )

  return `【Active Conversation Context｜当前仍有效的短期上下文】
这些事项只是帮助你自然保持连续性。仅在当前对话合适时使用，不要逐条复述，不要为了证明记得而主动全部提起，也不要把它们当成 checklist。

${lines.join("\n")}`
}

import { sourceEvidenceIsQuoted } from "./userSourceEvidence.js"

export const ACTIVE_CONTEXT_MAX_ITEMS = 4
export const ACTIVE_CONTEXT_MAX_CHARS = 420
export const ACTIVE_CONTEXT_TRANSIENT_MAX_MISSED_TURNS = 3
export const ACTIVE_CONTEXT_MAX_MENTION_PREFERENCES = 3

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

export function normalizeActiveConversationContext(value, { includeSourceEvidence = false } = {}) {
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
      ...(includeSourceEvidence
        ? { source_evidence: compactText(rawItem?.source_evidence, 160) || null }
        : {}),
    })
    usedChars += topic.length + normalizedContext.length
  }

  const mentionPreferences = []
  for (const rawPreference of Array.isArray(value.mention_preferences)
    ? value.mention_preferences
    : []) {
    if (mentionPreferences.length >= ACTIVE_CONTEXT_MAX_MENTION_PREFERENCES) break
    const topic = compactText(rawPreference?.topic, 60)
    const sourceMessageId = compactText(rawPreference?.source_message_id, 120)
    if (!topic || !sourceMessageId) continue
    mentionPreferences.push({
      topic,
      action: rawPreference?.action === "allow" ? "allow" : "suppress",
      scope: rawPreference?.scope === "all_mentions" ? "all_mentions" : "unsolicited_check_in",
      strength: rawPreference?.strength === "firm" ? "firm" : "soft",
      source_message_id: sourceMessageId,
      ...(includeSourceEvidence
        ? { evidence_text: compactText(rawPreference?.evidence_text, 160) || null }
        : {}),
    })
  }

  return mentionPreferences.length
    ? { items, mention_preferences: mentionPreferences }
    : { items }
}

export function resolveActiveConversationContext(
  previous,
  candidate,
  {
    currentUserMessageId = null,
    userSourceLedger = [],
    provenanceDiagnostics = null,
  } = {}
) {
  const normalizedPrevious = normalizeActiveConversationContext(previous)
  const normalizedCandidate = normalizeActiveConversationContext(candidate, {
    includeSourceEvidence: true,
  })

  if (!normalizedCandidate) return normalizedPrevious ?? { items: [] }

  const previousBySource = new Map(
    (normalizedPrevious?.items || []).map(item => [
      item.source_message_id || item.topic,
      item,
    ])
  )

  const previousKeys = new Set(
    (normalizedPrevious?.items || []).map(item => item.source_message_id || item.topic)
  )
  const sourceTextById = new Map(
    (userSourceLedger || [])
      .filter(item => item?.role === "user" && item?.id)
      .map(item => [String(item.id), compactText(item.content, 800)])
  )
  const evidenceSupportedBy = (messageId, item) => {
    const sourceText = sourceTextById.get(messageId)
    return sourceEvidenceIsQuoted(sourceText, item.source_evidence)
  }

  const items = normalizedCandidate.items
    .filter(item => item.status !== "resolved")
    .filter(item => {
      const existing = previousKeys.has(item.source_message_id || item.topic)
      const validSource = existing || evidenceSupportedBy(item.source_message_id, item)
      if (Array.isArray(provenanceDiagnostics)) {
        provenanceDiagnostics.push({
          topic: item.topic,
          proposed_source_id: item.source_message_id,
          validated_source_id: validSource ? item.source_message_id : null,
          rejection_reason: validSource ? null : "invalid_source_provenance",
        })
      }
      return validSource
    })
    .map(item => {
      const previousItem = previousBySource.get(item.source_message_id || item.topic)
      // Only a current user message may refresh attention. Memory retrieval,
      // prompt injection, semantic relevance, and assistant mentions are facts
      // available to the model, not evidence that the user still wants the topic.
      const explicitlyReferenced = Boolean(
        currentUserMessageId
        && item.last_referenced_message_id === currentUserMessageId
        && evidenceSupportedBy(currentUserMessageId, item)
      )
      const missedTurns = explicitlyReferenced
        ? 0
        : Math.min(99, (previousItem?.missed_turns || 0) + 1)

      const { source_evidence: _sourceEvidence, ...storedItem } = item
      return { ...storedItem, missed_turns: missedTurns }
    })
    .filter(item => (
      item.kind !== "transient"
      || item.missed_turns < ACTIVE_CONTEXT_TRANSIENT_MAX_MISSED_TURNS
    ))

  const previousPreferences = normalizedPrevious?.mention_preferences || []
  const proposedPreferences = normalizedCandidate.mention_preferences || []
  const preferencesByTopic = new Map(previousPreferences.map(item => [item.topic, item]))
  for (const preference of proposedPreferences) {
    const sourceText = sourceTextById.get(preference.source_message_id)
    const evidenceVerified = sourceEvidenceIsQuoted(sourceText, preference.evidence_text)
    const isCurrentEvidence = Boolean(
      currentUserMessageId
      && preference.source_message_id === currentUserMessageId
      && evidenceVerified
    )
    const hasRealUserEvidence = Boolean(sourceText && evidenceVerified)
    if (preference.action === "allow" ? !isCurrentEvidence : !hasRealUserEvidence) continue
    if (preference.action === "allow") {
      preferencesByTopic.delete(preference.topic)
    } else {
      const { evidence_text: _evidenceText, ...storedPreference } = preference
      preferencesByTopic.set(preference.topic, storedPreference)
    }
  }

  return normalizeActiveConversationContext({
    items,
    mention_preferences: [...preferencesByTopic.values()],
  }) ?? { items: [] }
}

export function formatActiveConversationContext(context, { recentMessageIds = [] } = {}) {
  const normalized = normalizeActiveConversationContext(context)
  const recentIds = new Set(recentMessageIds.filter(Boolean))
  const visibleItems = (normalized?.items || []).filter(item => (
    !item.source_message_id || !recentIds.has(item.source_message_id)
  ))
  const mentionPreferences = normalized?.mention_preferences || []
  if (!visibleItems.length && !mentionPreferences.length) return ""

  const lines = visibleItems.map(item =>
    `- ${item.topic}：${item.context}`
  )

  const mentionPreferencesPrompt = formatMentionPreferences(normalized)

  return `【Active Conversation Context｜当前仍有效的短期上下文】
这些事项只是帮助你自然保持连续性。仅在当前对话合适时使用，不要逐条复述，不要为了证明记得而主动全部提起，也不要把它们当成 checklist。

${lines.join("\n")}
${mentionPreferencesPrompt ? `\n${mentionPreferencesPrompt}` : ""}`
}

export function formatMentionPreferences(context) {
  const mentionPreferences = normalizeActiveConversationContext(context)?.mention_preferences || []
  if (!mentionPreferences.length) return ""
  const lines = mentionPreferences.map(preference => (
    `- ${preference.topic}：${preference.scope === "all_mentions" ? "除非她主动重提，否则不要主动带回这个话题" : "不要把它作为无新证据的主动检查或反复追问；她主动重提时正常回应"}`
  ))
  return `【Mention Preferences｜她明确表达的提及边界】\n${lines.join("\n")}`
}

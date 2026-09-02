export function validateTreeholeSourceEvidence(sourceEvidence, sourceMessages = []) {
  if (!Array.isArray(sourceEvidence) || sourceEvidence.length === 0) {
    return { valid: false, reason: "missing_source_evidence", sourceMessageIds: [] }
  }

  const sourcesById = new Map(
    sourceMessages
      .filter((message) => message?.id && ["user", "assistant"].includes(message?.role))
      .map((message) => [String(message.id), {
        role: message.role,
        content: String(message.content || ""),
      }])
  )
  const sourceMessageIds = []

  for (const evidence of sourceEvidence.slice(0, 4)) {
    const messageId = String(evidence?.message_id || "").trim()
    const sourceRole = String(evidence?.source_role || "").trim()
    const evidenceText = String(evidence?.evidence_text || "").trim()
    const source = sourcesById.get(messageId)

    if (!source || source.role !== sourceRole || !evidenceText) {
      return { valid: false, reason: "invalid_source_provenance", sourceMessageIds: [] }
    }
    if (!source.content.includes(evidenceText)) {
      return { valid: false, reason: "evidence_not_in_source", sourceMessageIds: [] }
    }
    sourceMessageIds.push(messageId)
  }

  return {
    valid: true,
    reason: null,
    sourceMessageIds: Array.from(new Set(sourceMessageIds)),
  }
}

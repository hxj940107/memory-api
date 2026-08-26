import { isContextuallyDuplicate } from "./mainChatContext.js"

export const SUMMARY_SEGMENT_VERSION = 1
export const SUMMARY_SEGMENT_MAX_COUNT = 8
export const SUMMARY_SEGMENT_TOTAL_CHARS = 5200

const UNSAFE_ASSISTANT_ONCE_PATTERN = /开玩笑|打个比方|只是比喻|我刚才说错|我之前其实(?:没|没有|从来没)|我从来没有|假设我/

export function normalizeSummarySegments(value) {
  if (!Array.isArray(value)) return []
  return value.map((segment, index) => ({
    id: String(segment?.id || `segment-${index + 1}`),
    version: Number(segment?.version) || SUMMARY_SEGMENT_VERSION,
    content: String(segment?.content || "").trim(),
    covered_message_ids: [...new Set(
      Array.isArray(segment?.covered_message_ids)
        ? segment.covered_message_ids.filter(Boolean).map(String)
        : []
    )],
    covered_until: segment?.covered_until || null,
    created_at: segment?.created_at || null,
  })).filter(segment => segment.content)
}

export function getCoveredMessageIds(segments) {
  return new Set(normalizeSummarySegments(segments)
    .flatMap(segment => segment.covered_message_ids))
}

export function selectUnsummarizedOutsideRecent(messages, segments, recentMessageIds) {
  const covered = getCoveredMessageIds(segments)
  const recent = new Set((recentMessageIds || []).filter(Boolean).map(String))
  return (messages || []).filter(message => (
    message?.id
    && !covered.has(String(message.id))
    && !recent.has(String(message.id))
  ))
}

export function sanitizeSummaryEvidence(messages) {
  const source = messages || []
  return source.filter((message, index) => {
    if (message?.role !== "assistant") return true
    const content = String(message.content || "")
    if (!UNSAFE_ASSISTANT_ONCE_PATTERN.test(content)) return true
    return source.slice(index + 1).some(later => (
      later.role === "user" && isContextuallyDuplicate(content, later.content)
    ))
  })
}

export function createSummarySegment({ content, messages, id, createdAt }) {
  const covered = (messages || []).filter(item => item?.id)
  return {
    id,
    version: SUMMARY_SEGMENT_VERSION,
    content: String(content || "").trim(),
    covered_message_ids: covered.map(item => String(item.id)),
    covered_until: covered.at(-1)?.created_at || null,
    created_at: createdAt,
  }
}

export function selectSummarySegmentsForPrompt(segments, recentMessageIds, maxChars) {
  const recent = new Set((recentMessageIds || []).filter(Boolean).map(String))
  const eligible = normalizeSummarySegments(segments).filter(segment => (
    !segment.covered_message_ids.some(id => recent.has(id))
  ))
  const selected = []
  let usedChars = 0
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const segment = eligible[index]
    if (usedChars + segment.content.length > maxChars) break
    selected.unshift(segment)
    usedChars += segment.content.length
  }
  return { segments: selected, content: selected.map(item => item.content).join("\n\n"), usedChars }
}

export function shouldCompressSummarySegments(segments, {
  maxSegments = SUMMARY_SEGMENT_MAX_COUNT,
  maxChars = SUMMARY_SEGMENT_TOTAL_CHARS,
} = {}) {
  const normalized = normalizeSummarySegments(segments)
  return normalized.length > maxSegments
    || normalized.reduce((total, item) => total + item.content.length, 0) > maxChars
}

export function selectOldestSegmentsForCompression(segments, keepNewest = 4) {
  const normalized = normalizeSummarySegments(segments)
  if (normalized.length < 2) return []
  const compressionCount = Math.max(2, normalized.length - keepNewest)
  return normalized.slice(0, Math.min(compressionCount, normalized.length))
}

export function mergeCompressedSummarySegments(sourceSegments, content, { id, createdAt }) {
  const normalized = normalizeSummarySegments(sourceSegments)
  return {
    id,
    version: SUMMARY_SEGMENT_VERSION,
    content: String(content || "").trim(),
    covered_message_ids: [...new Set(normalized.flatMap(item => item.covered_message_ids))],
    covered_until: normalized.at(-1)?.covered_until || null,
    created_at: createdAt,
  }
}

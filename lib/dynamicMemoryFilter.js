import { evaluateContextCandidates } from "./contextEligibility.js"

const SEARCH_HEADER = "[Ombre Brain - 相关记忆]"
const SEARCH_SEPARATOR = "\n---\n"

export const LEGACY_CORE_MEMORY_BUCKET_IDS = [
  "ec13b47392f3",
  "40d70666dcde",
  "cfce2d8a2943",
  "7c3eb5fb03b3",
  "95003cee3453",
]

function normalize(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim()
}

function parseSearchEntry(entry, index) {
  const normalized = normalize(entry).replace(`${SEARCH_HEADER}\n`, "")
  const separatorIndex = normalized.search(/[:：]/)

  if (separatorIndex < 0) {
    return { raw: normalized, title: "", content: normalized, candidateId: `ombre-${index + 1}` }
  }

  return {
    raw: normalized,
    title: normalize(normalized.slice(0, separatorIndex)),
    content: normalize(normalized.slice(separatorIndex + 1)),
    candidateId: `ombre-${index + 1}`,
  }
}

function isExplicitMatch(entry, excludedMemory) {
  const excludedTitle = normalize(excludedMemory?.title)
  const excludedContent = normalize(excludedMemory?.content)

  if (excludedTitle && entry.title === excludedTitle) return true
  if (!excludedContent || !entry.content) return false
  if (entry.content === excludedContent) return true

  // Ombre may truncate a search result. This checks identity by exact prefix,
  // not semantic or embedding similarity.
  if (Math.min(entry.content.length, excludedContent.length) < 80) return false
  return excludedContent.startsWith(entry.content) || entry.content.startsWith(excludedContent)
}

export function filterDynamicMemorySearchText(
  searchText,
  excludedMemories,
  { suppressionTexts = [], currentMessage = "" } = {}
) {
  return evaluateDynamicMemorySearchText(searchText, excludedMemories, {
    suppressionTexts,
    currentMessage,
  }).text
}

export function evaluateDynamicMemorySearchText(
  searchText,
  excludedMemories,
  {
    suppressionTexts = [],
    recentTexts = suppressionTexts,
    activeTexts = [],
    summaryTexts = [],
    coreTexts = [],
    currentMessage = "",
    currentConversationId = null,
    maxChars = Infinity,
    minimumRelevance = null,
  } = {}
) {
  const text = normalize(searchText)
  if (!text) return { text: "", diagnostics: [], injected: [] }

  const entries = text
    .split(SEARCH_SEPARATOR)
    .map(parseSearchEntry)
    .filter(entry => entry.raw)
    .map(entry => ({
      ...entry,
      source: "dynamic",
      duplicateWithCore: (excludedMemories || [])
        .some(memory => isExplicitMatch(entry, memory)),
    }))
  const result = evaluateContextCandidates(entries, {
    recentTexts,
    activeTexts,
    summaryTexts,
    coreTexts,
    currentMessage,
    currentConversationId,
  }, { maxChars, minimumRelevance })

  return {
    text: result.injected.length
      ? `${SEARCH_HEADER}\n${result.injected.map(entry => entry.raw).join(SEARCH_SEPARATOR)}`
      : "",
    diagnostics: result.diagnostics,
    injected: result.injected,
  }
}

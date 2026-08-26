import { isContextuallyDuplicate } from "./mainChatContext.js"

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

function parseSearchEntry(entry) {
  const normalized = normalize(entry).replace(`${SEARCH_HEADER}\n`, "")
  const separatorIndex = normalized.search(/[:：]/)

  if (separatorIndex < 0) {
    return { raw: normalized, title: "", content: normalized }
  }

  return {
    raw: normalized,
    title: normalize(normalized.slice(0, separatorIndex)),
    content: normalize(normalized.slice(separatorIndex + 1)),
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
  const text = normalize(searchText)
  if (!text) return ""

  const entries = text
    .split(SEARCH_SEPARATOR)
    .map(parseSearchEntry)
    .filter(entry => entry.raw)
  const remaining = entries.filter(
    entry => !(excludedMemories || []).some(memory => isExplicitMatch(entry, memory))
  )
  const deduplicated = []
  for (const entry of remaining) {
    if (deduplicated.some(existing => (
      isContextuallyDuplicate(existing.content, entry.content)
    ))) continue

    const explicitlyRelevantNow = currentMessage
      && isContextuallyDuplicate(entry.content, currentMessage)
    const duplicatedInShortTermContext = !explicitlyRelevantNow
      && suppressionTexts.some(text => isContextuallyDuplicate(entry.content, text))

    if (!duplicatedInShortTermContext) deduplicated.push(entry)
  }

  if (!deduplicated.length) return ""
  return `${SEARCH_HEADER}\n${deduplicated.map(entry => entry.raw).join(SEARCH_SEPARATOR)}`
}

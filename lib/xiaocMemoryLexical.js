const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u

export function normalizeLexicalText(value) {
  const source = String(value || "").normalize("NFKC").toLocaleLowerCase("und")
  let output = ""
  let pendingBoundary = false
  for (const char of source) {
    if (LETTER_OR_NUMBER.test(char)) {
      if (pendingBoundary && output && !output.endsWith(" ")) output += " "
      output += char
      pendingBoundary = false
    } else if (/\s/u.test(char)) {
      pendingBoundary = true
    } else {
      // Punctuation, symbols and emoji create a boundary instead of gluing words.
      pendingBoundary = true
    }
  }
  return output.trim().replace(/\s+/g, " ")
}

function compact(value) {
  // Keep boundaries introduced by punctuation/emoji so unrelated neighbors
  // cannot become a new token through normalization.
  return normalizeLexicalText(value)
}

function lexicalTokens(value) {
  const normalized = normalizeLexicalText(value)
  const tokens = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu) || []
  return new Set(tokens.filter(Boolean))
}

function ngrams(text, size) {
  const result = new Set()
  for (let index = 0; index <= text.length - size; index += 1) result.add(text.slice(index, index + size))
  return result
}

function overlapRatio(left, right) {
  if (!left.size || !right.size) return 0
  let overlap = 0
  for (const value of left) if (right.has(value)) overlap += 1
  // Retrieval asks how much of the query is represented by the candidate;
  // a longer Memory must not be penalized merely for containing more detail.
  return overlap / left.size
}

export function scoreLexicalMatch(query, content) {
  const normalizedQuery = normalizeLexicalText(query)
  const normalizedContent = normalizeLexicalText(content)
  const queryCompact = compact(query)
  const contentCompact = compact(content)
  const reasonCodes = []
  const components = {
    exact: 0,
    substring: 0,
    tokenOverlap: 0,
    characterNgramOverlap: 0,
    numericEntityOverlap: 0,
  }
  if (!queryCompact || !contentCompact) return { score: 0, reasonCodes: ["LEXICAL_EMPTY"], components }

  if (queryCompact === contentCompact) {
    components.exact = 1
    reasonCodes.push("LEXICAL_EXACT_NORMALIZED")
  }

  const shortQuery = [...queryCompact].length < 2
  if (!shortQuery && (contentCompact.includes(queryCompact) || queryCompact.includes(contentCompact))) {
    const coverage = Math.min(queryCompact.length, contentCompact.length) / Math.max(queryCompact.length, contentCompact.length)
    components.substring = 0.72 + 0.23 * coverage
    reasonCodes.push("LEXICAL_SUBSTRING")
  }

  const queryTokens = lexicalTokens(normalizedQuery)
  const contentTokens = lexicalTokens(normalizedContent)
  components.tokenOverlap = overlapRatio(queryTokens, contentTokens)
  if (components.tokenOverlap > 0) reasonCodes.push("LEXICAL_TOKEN_OVERLAP")

  const queryLength = [...queryCompact].length
  if (queryLength >= 4) {
    const gramSize = queryLength >= 7 ? 3 : 2
    components.characterNgramOverlap = overlapRatio(ngrams(queryCompact, gramSize), ngrams(contentCompact, gramSize))
    if (components.characterNgramOverlap > 0) reasonCodes.push("LEXICAL_CHARACTER_NGRAM")
  } else if (!components.exact && !components.substring) {
    reasonCodes.push("LEXICAL_SHORT_QUERY_PROTECTED")
  }

  const queryNumbers = new Set(normalizedQuery.match(/\d+(?:[./:-]\d+)*/g) || [])
  const contentNumbers = new Set(normalizedContent.match(/\d+(?:[./:-]\d+)*/g) || [])
  components.numericEntityOverlap = overlapRatio(queryNumbers, contentNumbers)
  if (components.numericEntityOverlap > 0) reasonCodes.push("LEXICAL_NUMERIC_ENTITY")

  const score = Math.min(1, Math.max(
    components.exact,
    components.substring,
    components.tokenOverlap * 0.72,
    components.characterNgramOverlap * 0.62,
    components.numericEntityOverlap * 0.55,
  ))
  return {
    score: Number(score.toFixed(6)),
    reasonCodes: [...new Set(reasonCodes)],
    components,
    normalizedQuery,
    normalizedContent,
    shortQuery,
  }
}

export function containsCjk(value) {
  return [...String(value || "")].some((char) => CJK.test(char))
}

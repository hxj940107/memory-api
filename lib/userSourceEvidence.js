function compactText(value, maxChars = 800) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxChars)
}

function semanticCharacters(value) {
  return [...compactText(value).toLocaleLowerCase()]
    .filter(character => /[\p{L}\p{N}]/u.test(character))
}

function semanticWords(value) {
  return compactText(value)
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || []
}

export function sourceEvidenceIsQuoted(sourceContent, sourceEvidence) {
  const source = compactText(sourceContent).toLocaleLowerCase()
  const evidence = compactText(sourceEvidence, 160).toLocaleLowerCase()
  return Boolean(source && evidence && source.includes(evidence))
}

export function semanticEvidenceScore(sourceContent, eventText) {
  const sourceChars = new Set(semanticCharacters(sourceContent))
  const eventChars = new Set(semanticCharacters(eventText))
  let characterOverlap = 0
  for (const character of sourceChars) {
    if (eventChars.has(character)) characterOverlap += 1
  }

  const sourceWords = new Set(semanticWords(sourceContent))
  const eventWords = new Set(semanticWords(eventText))
  let wordOverlap = 0
  for (const word of sourceWords) {
    if (word.length >= 2 && eventWords.has(word)) wordOverlap += 1
  }

  return { characterOverlap, wordOverlap }
}

export function sourceSemanticallySupportsEvent({
  sourceContent,
  eventText,
  sourceEvidence = null,
}) {
  const source = compactText(sourceContent)
  const event = compactText(eventText, 240)
  if (!source || !event) return false
  if (sourceEvidence && !sourceEvidenceIsQuoted(source, sourceEvidence)) return false

  const { characterOverlap, wordOverlap } = semanticEvidenceScore(source, event)
  return wordOverlap >= 1 || characterOverlap >= 2
}


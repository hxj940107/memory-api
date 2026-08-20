const REASONING_BLOCK_TYPES = new Set([
  "analysis",
  "reasoning",
  "thinking",
  "redacted_thinking",
])

const VISIBLE_TEXT_BLOCK_TYPES = new Set([
  "text",
  "output_text",
])

function stripExplicitReasoningBlocks(content) {
  const lines = String(content || "").split("\n")
  const kept = []
  let fenceMarker = null
  let reasoningTag = null

  for (const line of lines) {
    const fence = line.match(/^\s*(```|~~~)/)?.[1]

    if (!reasoningTag && fence) {
      fenceMarker = fenceMarker === fence ? null : (fenceMarker || fence)
      kept.push(line)
      continue
    }

    if (fenceMarker) {
      kept.push(line)
      continue
    }

    if (!reasoningTag) {
      const completeBlock = line.match(
        /^\s*<(thinking|analysis)(?:\s[^>]*)?>.*<\/\1>\s*$/i,
      )
      if (completeBlock) continue

      const opening = line.match(/^\s*<(thinking|analysis)(?:\s[^>]*)?>\s*$/i)
      if (opening) {
        reasoningTag = opening[1].toLowerCase()
        continue
      }

      kept.push(line)
      continue
    }

    if (new RegExp(`^\\s*</${reasoningTag}>\\s*$`, "i").test(line)) {
      reasoningTag = null
    }
  }

  while (kept[0] === "") kept.shift()
  while (kept[kept.length - 1] === "") kept.pop()

  return kept.join("\n")
}

function readVisibleBlockText(block) {
  if (!block || typeof block !== "object") return ""

  const type = String(block.type || "").toLowerCase()
  if (REASONING_BLOCK_TYPES.has(type)) return ""
  if (!VISIBLE_TEXT_BLOCK_TYPES.has(type)) return ""

  if (typeof block.text === "string") return block.text
  if (typeof block.content === "string") return block.content
  return ""
}

export function normalizeAssistantOutput(message) {
  if (!message || typeof message !== "object") return ""

  if (message.role && message.role !== "assistant") {
    return typeof message.content === "string" ? message.content : ""
  }

  const content = message.content
  const visible = Array.isArray(content)
    ? content.map(readVisibleBlockText).join("")
    : typeof content === "string"
      ? content
      : ""

  return stripExplicitReasoningBlocks(visible)
}

const DEFAULT_REACTION_EMOJI = "🫢"

function getTreeholeReactionLikeCount(random = Math.random) {
  return 2 + Math.floor(random() * 47)
}

export function normalizeTreeholeReaction(reaction, content = [], random = Math.random) {
  const rawReaction = String(reaction || "").trim()
  const original = rawReaction === "🌙 偷偷偏心 · ❤️ 1" ? "" : rawReaction
  const fallbackText = Array.isArray(content)
    ? String(content.find((line) => String(line).trim()) || "").trim().slice(0, 18)
    : ""
  let normalized = original || fallbackText || "先记在这里"

  if (!/^\p{Extended_Pictographic}/u.test(normalized)) {
    normalized = `${DEFAULT_REACTION_EMOJI} ${normalized}`
  }

  if (!/·\s*❤️\s*\d+\s*$/u.test(normalized)) {
    normalized = `${normalized} · ❤️ ${getTreeholeReactionLikeCount(random)}`
  }

  return normalized
}

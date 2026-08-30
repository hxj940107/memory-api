const trim = (value, limit) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit)

export function buildMomentSourceMaterials(messages = [], {
  currentUserMessageId = null,
  currentImageDescription = "",
} = {}) {
  return messages
    .filter(item => item?.role === "user" && item?.id && item?.content)
    .map((item, index) => ({
      alias: `u${index + 1}`,
      messageId: String(item.id),
      createdAt: item.created_at || null,
      text: trim(item.content, 500),
      imageDescription: trim(
        String(item.id) === String(currentUserMessageId) && currentImageDescription
          ? currentImageDescription
          : item.metadata?.imageDescription,
        700,
      ) || null,
    }))
}

export function resolveMomentSourceMaterial(materials = [], reference = "") {
  const normalized = String(reference || "").trim()
  if (!normalized) return null

  return materials.find(item =>
    item.alias === normalized || item.messageId === normalized
  ) || null
}

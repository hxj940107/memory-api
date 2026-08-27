export function getSavedMessageId(payload) {
  const messageId = payload?.data?.[0]?.id
  return typeof messageId === "string" && messageId.trim()
    ? messageId
    : null
}

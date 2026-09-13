export function getSavedMessageId(payload) {
  const messageId = payload?.data?.[0]?.id
  return typeof messageId === "string" && messageId.trim()
    ? messageId
    : null
}

export function requireSavedMessageId({
  ok,
  status,
  payload,
  role = "message",
}) {
  if (!ok) {
    const error = new Error(
      payload?.error || `Unable to save ${role} message: ${status}`
    )
    error.code = payload?.code || "message_persistence_failed"
    error.status = Number(status) || 500
    throw error
  }

  const messageId = getSavedMessageId(payload)
  if (!messageId) {
    const error = new Error(
      `Saved ${role} message response is missing a string id`
    )
    error.code = "message_persistence_failed"
    error.status = 502
    throw error
  }

  return messageId
}

export function hasUserRepliedToInactivityTask(task, latestUserMessage) {
  if (!latestUserMessage) return true

  return String(latestUserMessage.id) !== String(task.payload?.user_message_id)
}

export function shouldApplyProactiveCooldown(message, task) {
  if (!message.metadata?.proactive) return false
  if (String(message.metadata?.proactiveTaskId || "") === String(task.id)) {
    return false
  }

  const continuationParentMessageId = task.type === "inactivity_reach_out" &&
    task.source_type === "proactive_message"
    ? task.payload?.assistant_message_id || task.source_id
    : null

  if (continuationParentMessageId &&
      String(message.id) === String(continuationParentMessageId)) {
    return false
  }

  return true
}

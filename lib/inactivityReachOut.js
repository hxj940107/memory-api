export function hasUserRepliedToInactivityTask(task, latestUserMessage) {
  if (!latestUserMessage) return true

  return String(latestUserMessage.id) !== String(task.payload?.user_message_id)
}

export function shouldApplyProactiveCooldown(message, task) {
  if (!message.metadata?.proactive) return false
  if (String(message.metadata?.proactiveTaskId || "") === String(task.id)) {
    return false
  }

  return true
}

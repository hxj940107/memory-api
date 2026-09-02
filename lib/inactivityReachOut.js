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

export function getInactivityAttemptIndex(task) {
  return Math.max(1, Math.min(3, Number(task?.payload?.attempt_index || 1)))
}

export function getInactivityAttemptLimit(mode) {
  if (mode === "frequent") return 3
  if (mode === "normal") return 2
  if (mode === "relaxed") return 1
  return 0
}

export function getNextInactivityDelayMinutes(nextAttemptIndex, random = Math.random) {
  const range = nextAttemptIndex === 2
    ? [60, 120]
    : nextAttemptIndex === 3
      ? [120, 180]
      : null
  if (!range) return null
  return range[0] + Math.floor(random() * (range[1] - range[0] + 1))
}

export function canContinueInactivityChain(task, mode) {
  return getInactivityAttemptIndex(task) < getInactivityAttemptLimit(mode)
}

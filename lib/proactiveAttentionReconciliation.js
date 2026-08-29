import { planProactiveAttentionWakeup } from "./proactiveAttentionScheduler.js"

function validTime(value) {
  const time = value ? new Date(value).getTime() : NaN
  return Number.isFinite(time) ? time : null
}

export function planExistingCandidateWakeupReconciliation({
  candidate,
  existingTask = null,
  sourceMessageValid = false,
  now = new Date().toISOString(),
} = {}) {
  const start = validTime(candidate?.expected_window?.start)
  const end = validTime(candidate?.expected_window?.end)

  if (!start || !end) {
    return { action: "none", reason: "incomplete_expected_window", decision: null }
  }
  if (end <= start) {
    return { action: "none", reason: "invalid_expected_window", decision: null }
  }
  if (!sourceMessageValid) {
    return { action: "none", reason: "invalid_source_message", decision: null }
  }

  const decision = planProactiveAttentionWakeup(candidate, { now })
  if (!decision.scheduled) {
    return { action: "none", reason: decision.reason, decision }
  }

  if (existingTask?.status === "processing") {
    return { action: "none", reason: "existing_processing_task", decision }
  }

  const scheduledFor = new Date(decision.scheduled_for).toISOString()
  const existingDueAt = validTime(existingTask?.due_at)
  const sameSchedule = existingDueAt === validTime(scheduledFor)
  const sameCandidateVersion = String(
    existingTask?.payload?.candidate_updated_at || ""
  ) === String(candidate.updated_at || "")
  const candidateUpdatedAt = validTime(candidate.updated_at)
  const taskCompletedAt = validTime(existingTask?.completed_at || existingTask?.updated_at)

  if (existingTask?.status === "pending" && sameSchedule && sameCandidateVersion) {
    return { action: "none", reason: "existing_pending_task", decision }
  }
  if (
    existingTask?.status === "completed"
    && (
      sameCandidateVersion
      || (candidateUpdatedAt && taskCompletedAt && taskCompletedAt >= candidateUpdatedAt)
    )
  ) {
    return { action: "none", reason: "existing_completed_task", decision }
  }

  return {
    action: existingTask?.status === "pending" ? "reschedule" : "upsert",
    reason: existingTask?.status === "pending"
      ? "candidate_rescheduled"
      : "missing_effective_wakeup",
    scheduled_for: scheduledFor,
    decision,
  }
}

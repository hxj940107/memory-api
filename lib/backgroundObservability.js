export const OBSERVABILITY_RETENTION_DAYS = 60

export function shouldRunObservabilityCleanup(date = new Date()) {
  return date.getUTCMinutes() < 5
}

const TREEHOLE_REASON_CODES = new Set([
  "cooldown",
  "insufficient_new_messages",
  "insufficient_new_chars",
  "judge_declined",
  "judge_invalid_output",
  "publish_success",
  "publish_failed",
  "task_rescheduled",
  "exception",
])

function safeCount(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

export function safeObservabilityErrorCode(error) {
  const explicit = String(error?.observabilityCode || "").trim()
  if (explicit) return explicit.slice(0, 80)
  const message = String(error?.message || "")
  if (message === "treehole_generation_returned_no_visible_draft") {
    return "TREEHOLE_JUDGE_INVALID_OUTPUT"
  }
  return error ? "UNCLASSIFIED_ERROR" : null
}

export function classifyTreeholeExecution({ result = null, error = null, trace = {} } = {}) {
  if (error) {
    if (safeObservabilityErrorCode(error) === "TREEHOLE_JUDGE_INVALID_OUTPUT") {
      return { reasonCode: "judge_invalid_output", judgeResult: "invalid_output", publishResult: "not_attempted" }
    }
    if (safeObservabilityErrorCode(error) === "TREEHOLE_PUBLISH_FAILED") {
      return { reasonCode: "publish_failed", judgeResult: "approved", publishResult: "failed" }
    }
    return { reasonCode: "exception", judgeResult: trace.judgeAttempted ? "error" : "not_attempted", publishResult: trace.publishAttempted ? "error" : "not_attempted" }
  }
  if (result?.payload?.treehole_generation_result === "visible_entries_written") {
    return { reasonCode: "publish_success", judgeResult: "approved", publishResult: "success" }
  }
  if (result?.payload?.treehole_generation_result === "no_worthy_draft") {
    return { reasonCode: "judge_declined", judgeResult: "declined", publishResult: "not_attempted" }
  }
  if (result?.payload?.treehole_prefilter_reason === "insufficient_new_material") {
    return {
      reasonCode: result.payload.treehole_prefilter_detail === "insufficient_new_chars"
        ? "insufficient_new_chars"
        : "insufficient_new_messages",
      judgeResult: "not_attempted",
      publishResult: "not_attempted",
    }
  }
  if (result?.deferred && /刚更新过树洞/.test(String(result.reason || ""))) {
    return { reasonCode: "cooldown", judgeResult: "not_attempted", publishResult: "not_attempted" }
  }
  return { reasonCode: "task_rescheduled", judgeResult: "not_attempted", publishResult: "not_attempted" }
}

export function buildTreeholeExecutionAudit({ task, startedAt, finishedAt, result = null, error = null, trace = {} }) {
  const outcome = classifyTreeholeExecution({ result, error, trace })
  if (!TREEHOLE_REASON_CODES.has(outcome.reasonCode)) throw new Error("invalid treehole audit reason")
  const payload = result?.payload || {}
  return {
    user_id: String(task.user_id),
    task_id: task.id,
    scheduled_for: task.due_at,
    started_at: startedAt,
    finished_at: finishedAt,
    new_user_message_count: safeCount(payload.treehole_new_user_message_count ?? trace.newUserMessageCount),
    new_user_char_count: safeCount(payload.treehole_new_user_chars ?? trace.newUserChars),
    prefilter_result: payload.treehole_prefilter_reason || trace.prefilterResult || "not_reached",
    judge_attempted: Boolean(payload.treehole_generation_attempted ?? trace.judgeAttempted),
    judge_result: outcome.judgeResult,
    publish_attempted: Boolean(trace.publishAttempted || outcome.publishResult === "success" || outcome.publishResult === "failed"),
    publish_result: outcome.publishResult,
    reason_code: outcome.reasonCode,
    error_code: safeObservabilityErrorCode(error),
    next_scheduled_for: result?.dueAt || null,
    duration_ms: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
  }
}

export function buildWorkerRunAudit({ userId, startedAt, finishedAt, result = null, error = null }) {
  const taskCounts = result?.proactive?.task_counts || {}
  const due = safeCount(result?.proactive?.checked) + safeCount(result?.momentCandidates?.checked)
  const processed = safeCount(taskCounts.processed) + safeCount(result?.momentCandidates?.checked)
  const failed = safeCount(result?.proactive?.failed) + safeCount(result?.momentCandidates?.failed)
  const succeeded = safeCount(result?.proactive?.completed) + safeCount(result?.momentCandidates?.published)
  const skipped = safeCount(taskCounts.skipped) + safeCount(result?.momentCandidates?.skipped)
  const runResult = error
    ? "FAILED"
    : failed > 0
      ? "PARTIAL_FAILURE"
      : due === 0
        ? "SUCCESS_NO_DUE_TASKS"
        : "SUCCESS_PROCESSED"
  return {
    user_id: String(userId || ""),
    worker_type: "xiaoc_background_check",
    started_at: startedAt,
    finished_at: finishedAt,
    tasks_due: due,
    tasks_processed: processed,
    tasks_succeeded: succeeded,
    tasks_skipped: skipped,
    tasks_failed: failed,
    treehole_tasks_processed: safeCount(taskCounts.by_type?.treehole_autonomous_update),
    proactive_tasks_processed: safeCount(taskCounts.by_type?.proactive_attention_wakeup) + safeCount(taskCounts.by_type?.inactivity_reach_out) + safeCount(taskCounts.by_type?.plan_follow_up),
    duration_ms: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
    result: runResult,
    error_code: safeObservabilityErrorCode(error),
  }
}

export async function bestEffortInsertAudit(client, table, row, logger = console) {
  try {
    const { error } = await client.from(table).insert(row)
    if (error && !["42P01", "PGRST205"].includes(error.code)) throw error
    return !error
  } catch (error) {
    logger.warn?.("OBSERVABILITY AUDIT WRITE SKIPPED:", {
      table,
      error_code: safeObservabilityErrorCode(error),
    })
    return false
  }
}

export async function bestEffortCleanupObservability(client, logger = console) {
  try {
    const { error } = await client.rpc("cleanup_xiaoc_observability_audits", {
      p_retention_days: OBSERVABILITY_RETENTION_DAYS,
    })
    if (error && !["42883", "PGRST202"].includes(error.code)) throw error
    return !error
  } catch (error) {
    logger.warn?.("OBSERVABILITY CLEANUP SKIPPED:", {
      error_code: safeObservabilityErrorCode(error),
    })
    return false
  }
}

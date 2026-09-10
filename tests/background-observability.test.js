import assert from "node:assert/strict"
import fs from "node:fs"
import {
  OBSERVABILITY_RETENTION_DAYS,
  bestEffortInsertAudit,
  buildTreeholeExecutionAudit,
  buildWorkerRunAudit,
  classifyTreeholeExecution,
  shouldRunObservabilityCleanup,
} from "../lib/backgroundObservability.js"

const task = {
  id: 41,
  user_id: "user",
  due_at: "2026-09-10T00:00:00.000Z",
}
const times = {
  startedAt: "2026-09-10T00:00:01.000Z",
  finishedAt: "2026-09-10T00:00:01.125Z",
}

const insufficientMessages = buildTreeholeExecutionAudit({
  task,
  ...times,
  result: {
    deferred: true,
    dueAt: "2026-09-11T00:00:00.000Z",
    payload: {
      treehole_prefilter_reason: "insufficient_new_material",
      treehole_prefilter_detail: "insufficient_new_messages",
      treehole_new_user_message_count: 1,
      treehole_new_user_chars: 400,
    },
  },
})
assert.equal(insufficientMessages.reason_code, "insufficient_new_messages")
assert.equal(insufficientMessages.judge_attempted, false)
assert.equal(insufficientMessages.next_scheduled_for, "2026-09-11T00:00:00.000Z")

const insufficientChars = buildTreeholeExecutionAudit({
  task,
  ...times,
  result: {
    deferred: true,
    payload: {
      treehole_prefilter_reason: "insufficient_new_material",
      treehole_prefilter_detail: "insufficient_new_chars",
      treehole_new_user_message_count: 2,
      treehole_new_user_chars: 159,
    },
  },
})
assert.equal(insufficientChars.reason_code, "insufficient_new_chars")

const declined = buildTreeholeExecutionAudit({
  task,
  ...times,
  result: { skipped: true, payload: { treehole_generation_attempted: true, treehole_generation_result: "no_worthy_draft" } },
})
assert.equal(declined.reason_code, "judge_declined")
assert.equal(declined.judge_result, "declined")

const invalidOutputError = new Error("treehole_generation_returned_no_visible_draft")
assert.equal(classifyTreeholeExecution({ error: invalidOutputError }).reasonCode, "judge_invalid_output")

const published = buildTreeholeExecutionAudit({
  task,
  ...times,
  result: { payload: { treehole_generation_attempted: true, treehole_generation_result: "visible_entries_written" } },
  trace: { publishAttempted: true },
})
assert.equal(published.reason_code, "publish_success")
assert.equal(published.publish_result, "success")

const publishError = new Error("database returned private details")
publishError.observabilityCode = "TREEHOLE_PUBLISH_FAILED"
const publishFailed = buildTreeholeExecutionAudit({ task, ...times, error: publishError, trace: { judgeAttempted: true, publishAttempted: true } })
assert.equal(publishFailed.reason_code, "publish_failed")
assert.equal(publishFailed.error_code, "TREEHOLE_PUBLISH_FAILED")
assert.doesNotMatch(JSON.stringify(publishFailed), /private details/)

const cooldown = buildTreeholeExecutionAudit({ task, ...times, result: { deferred: true, reason: "最近刚更新过树洞" } })
assert.equal(cooldown.reason_code, "cooldown")
assert.equal(buildTreeholeExecutionAudit({ task, ...times, result: { deferred: true } }).reason_code, "task_rescheduled")
assert.equal(buildTreeholeExecutionAudit({ task, ...times, error: new Error("secret body") }).reason_code, "exception")

for (const row of [insufficientMessages, insufficientChars, declined, published, publishFailed, cooldown]) {
  const keys = Object.keys(row)
  assert.equal(keys.some(key => /body|content|prompt|response|summary|embedding|query/i.test(key)), false)
}

const noDue = buildWorkerRunAudit({ userId: "user", ...times, result: { proactive: { checked: 0 }, momentCandidates: { checked: 0 } } })
assert.equal(noDue.result, "SUCCESS_NO_DUE_TASKS")
assert.equal(noDue.user_id, "user")

const processed = buildWorkerRunAudit({
  userId: "user",
  ...times,
  result: {
    proactive: { checked: 2, completed: 1, failed: 0, task_counts: { processed: 2, skipped: 1, by_type: { treehole_autonomous_update: 1, inactivity_reach_out: 1 } } },
    momentCandidates: { checked: 1, published: 1, skipped: 0, failed: 0 },
  },
})
assert.equal(processed.result, "SUCCESS_PROCESSED")
assert.deepEqual({ due: processed.tasks_due, processed: processed.tasks_processed, succeeded: processed.tasks_succeeded, skipped: processed.tasks_skipped }, { due: 3, processed: 3, succeeded: 2, skipped: 1 })
assert.equal(processed.treehole_tasks_processed, 1)
assert.equal(processed.proactive_tasks_processed, 1)

const partial = buildWorkerRunAudit({ userId: "user", ...times, result: { proactive: { checked: 1, failed: 1, task_counts: { processed: 1 } }, momentCandidates: {} } })
assert.equal(partial.result, "PARTIAL_FAILURE")
assert.equal(buildWorkerRunAudit({ userId: "user", ...times, error: new Error("private") }).result, "FAILED")
assert.doesNotMatch(JSON.stringify(buildWorkerRunAudit({ userId: "user", ...times, error: new Error("private body") })), /private body/)
assert.equal(shouldRunObservabilityCleanup(new Date("2026-09-10T10:02:00Z")), true)
assert.equal(shouldRunObservabilityCleanup(new Date("2026-09-10T10:05:00Z")), false)

let warnings = 0
const failedWrite = await bestEffortInsertAudit({
  from() {
    return { insert: async () => ({ error: { code: "XX000", message: "write failed" } }) }
  },
}, "audit", { result: "safe" }, { warn: () => { warnings += 1 } })
assert.equal(failedWrite, false)
assert.equal(warnings, 1)

const successfulWrite = await bestEffortInsertAudit({
  from() {
    return { insert: async () => ({ error: null }) }
  },
}, "audit", { result: "safe" })
assert.equal(successfulWrite, true)

const sql = fs.readFileSync("supabase_treehole_worker_observability.sql", "utf8")
assert.match(sql, /treehole_execution_audit/)
assert.match(sql, /background_worker_run_audit/)
assert.match(sql, /revoke insert, update, delete, truncate/i)
assert.equal((sql.match(/create table if not exists public\.treehole_execution_audit/g) || []).length, 1)
assert.doesNotMatch(sql, /update\s+public\.(?:treehole_execution_audit|background_worker_run_audit)/i)
assert.equal(OBSERVABILITY_RETENTION_DAYS, 60)

const permissionFix = fs.readFileSync("supabase_treehole_worker_observability_permission_fix.sql", "utf8")
assert.match(permissionFix, /revoke update, delete, truncate, references, trigger[\s\S]+from service_role/i)
assert.match(permissionFix, /grant select, insert on public\.treehole_execution_audit to service_role/i)
assert.match(permissionFix, /grant select, insert on public\.background_worker_run_audit to service_role/i)
assert.match(permissionFix, /owner to postgres/i)
assert.match(permissionFix, /set search_path = pg_catalog, public/i)
assert.doesNotMatch(permissionFix, /(?:insert into|update|delete from|truncate table) public\.(?:treehole_entries|xiaoc_proactive_tasks|messages|memories|moments)/i)

const permissionValidation = fs.readFileSync("supabase_treehole_worker_observability_permission_fix_validation.sql", "utf8")
assert.match(permissionValidation, /begin read only/i)
assert.match(permissionValidation, /rollback/i)
assert.doesNotMatch(permissionValidation, /insert into/i)

const memory = fs.readFileSync("api/memory.js", "utf8")
assert.match(memory, /TREEHOLE_AUTONOMOUS_POLICY\.minDelayHours/)
assert.match(memory, /TREEHOLE_AUTONOMOUS_POLICY\.minimumNewUserMessages/)
assert.match(memory, /TREEHOLE_AUTONOMOUS_POLICY\.minimumNewChatChars/)
assert.match(memory, /requestPurpose: "treehole_generation"/)
assert.match(memory, /buildTreeholeExecutionAudit/)
assert.match(memory, /buildWorkerRunAudit/)
assert.match(memory, /if \(workerError\) throw workerError/)
assert.doesNotMatch(memory, /runXiaoCMemoryShadowRead/)

console.log("background observability tests passed")

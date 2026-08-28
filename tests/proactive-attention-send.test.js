import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import { isProactiveAttentionSendEnabled } from "../lib/aiConfig.js"
import {
  buildProactiveAttentionIntent,
  buildProactiveAttentionPrompt,
  candidateSnapshotAfterProactiveSend,
  initialProactiveAttentionSendDiagnostics,
  validateFinalProactiveAttentionRecheck,
} from "../lib/proactiveAttentionSend.js"

const candidate = {
  event_id: "event-1",
  description: "下午去做雾化",
  state: "planned",
  attention_status: "open",
  source_message_ids: ["user-1"],
  last_user_update: { message_id: "user-1", text: "下午去做雾化" },
  expected_window: { start: "2026-08-28T07:00:00.000Z", end: "2026-08-28T09:00:00.000Z" },
  updated_at: "2026-08-28T06:00:00.000Z",
}

const execution = {
  gate_eligible: true,
  arbitration: "proactive_event_wins",
  would_send: true,
  execution_reason: "eligible_shadow_execution",
}

test("send flag is fail-closed and only exact true enables it", () => {
  assert.equal(isProactiveAttentionSendEnabled({}), false)
  assert.equal(isProactiveAttentionSendEnabled({ PROACTIVE_ATTENTION_SEND_ENABLED: "TRUE" }), false)
  assert.equal(isProactiveAttentionSendEnabled({ PROACTIVE_ATTENTION_SEND_ENABLED: "1" }), false)
  assert.equal(isProactiveAttentionSendEnabled({ PROACTIVE_ATTENTION_SEND_ENABLED: "true" }), true)
})

test("intent is only built for an execution-time winning event", () => {
  assert.equal(buildProactiveAttentionIntent({ candidate, execution: { ...execution, would_send: false } }), null)
  const intent = buildProactiveAttentionIntent({
    conversationId: "chat-1",
    candidate,
    execution,
    recentMessages: [{ role: "user", content: "晚点去", created_at: "now" }],
  })
  assert.equal(intent.event_id, "event-1")
  assert.equal(intent.recent_messages.length, 1)
})

test("generation prompt is narrow and does not expose internal lifecycle language as output", () => {
  const intent = buildProactiveAttentionIntent({ conversationId: "chat-1", candidate, execution })
  const prompt = buildProactiveAttentionPrompt({ systemPrompt: "persona", intent, localTime: "2026-08-28 16:00" })
  assert.equal(prompt.length, 2)
  assert.match(prompt[0].content, /自然事件回访/)
  assert.match(prompt[0].content, /不说“提醒你”/)
})

test("successful send carries the full snapshot and only marks its event", () => {
  const other = { ...candidate, event_id: "event-2", description: "另一个事件" }
  const snapshot = candidateSnapshotAfterProactiveSend({
    candidates: [candidate, other],
    eventId: "event-1",
    messageId: "assistant-1",
    taskId: "task-1",
    sentAt: "2026-08-28T08:00:00.000Z",
  })
  assert.equal(snapshot.length, 2)
  assert.equal(snapshot[0].last_proactive_mention.message_id, "assistant-1")
  assert.equal(snapshot[1].last_proactive_mention, null)
})

test("final recheck blocks candidate changes, user activity, and execution-policy changes", () => {
  const base = {
    beforeCandidate: candidate,
    beforeLatestUserMessageId: "user-1",
    afterCandidate: candidate,
    afterLatestUserMessageId: "user-1",
    afterExecution: execution,
  }
  assert.deepEqual(validateFinalProactiveAttentionRecheck(base), {
    passed: true,
    reason: "final_recheck_passed",
  })
  assert.equal(validateFinalProactiveAttentionRecheck({
    ...base,
    afterCandidate: { ...candidate, state: "completed", updated_at: "later" },
  }).reason, "candidate_changed_during_generation")
  assert.equal(validateFinalProactiveAttentionRecheck({
    ...base,
    afterLatestUserMessageId: "user-2",
  }).reason, "user_message_arrived_during_generation")
  assert.equal(validateFinalProactiveAttentionRecheck({
    ...base,
    afterExecution: { ...execution, gate_eligible: false, gate_reason: "quiet_hours" },
  }).reason, "quiet_hours")
  assert.equal(validateFinalProactiveAttentionRecheck({
    ...base,
    afterExecution: { ...execution, arbitration: "inactivity_wins", would_send: false },
  }).passed, false)
})

test("shadow diagnostics show generation was not attempted", () => {
  const diagnostics = initialProactiveAttentionSendDiagnostics({
    eventId: "event-1",
    taskId: "task-1",
    execution,
    sendEnabled: false,
  })
  assert.equal(diagnostics.execution_mode, "shadow")
  assert.equal(diagnostics.generation_attempted, false)
  assert.equal(diagnostics.generation_skipped_reason, "send_disabled")
})

test("API keeps OFF short-circuit before generation and uses task-id message idempotency", () => {
  const source = fs.readFileSync(new URL("../api/memory.js", import.meta.url), "utf8")
  const wakeup = source.slice(
    source.indexOf("async function executeProactiveAttentionWakeup"),
    source.indexOf("async function executeProactiveTask")
  )
  assert.ok(wakeup.indexOf("if (!sendEnabled || !execution.would_send)") < wakeup.indexOf("generateProactiveAttentionMessage"))
  assert.match(source, /metadata->>proactiveTaskId/)
  assert.match(source, /validateFinalProactiveAttentionRecheck/)
  assert.match(source, /proactiveAttentionCandidates: candidateSnapshotAfterProactiveSend/)
})

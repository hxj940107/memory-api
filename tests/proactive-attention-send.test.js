import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import { isProactiveAttentionSendEnabled } from "../lib/aiConfig.js"
import {
  buildProactiveAttentionIntent,
  buildProactiveAttentionPrompt,
  candidateSnapshotAfterProactiveSend,
  evaluateLimitedProactiveAttentionRollout,
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
  time_grounding: {
    source: "user_explicit_time",
    missing_user_message_time: false,
  },
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
  const rollout = evaluateLimitedProactiveAttentionRollout({
    candidate,
    execution,
    now: "2026-08-28T08:00:00.000Z",
  })
  const diagnostics = initialProactiveAttentionSendDiagnostics({
    eventId: "event-1",
    taskId: "task-1",
    execution,
    sendEnabled: false,
    rollout,
  })
  assert.equal(diagnostics.execution_mode, "shadow")
  assert.equal(diagnostics.generation_attempted, false)
  assert.equal(diagnostics.generation_skipped_reason, "send_disabled")
  assert.equal(diagnostics.rollout_eligible, true)
  assert.equal(diagnostics.inactivity_ownership_outcome, "not_consumed")
})

test("limited rollout waits until a natural point inside a complete grounded window", () => {
  const atStart = evaluateLimitedProactiveAttentionRollout({
    candidate,
    execution,
    now: "2026-08-28T07:00:01.000Z",
  })
  assert.equal(atStart.rollout_rejection_reason, "too_early_for_follow_up")
  assert.equal(atStart.next_evaluation_at, "2026-08-28T08:00:00.000Z")

  const naturalTime = evaluateLimitedProactiveAttentionRollout({
    candidate,
    execution,
    now: "2026-08-28T08:00:00.000Z",
  })
  assert.equal(naturalTime.rollout_eligible, true)
  assert.equal(naturalTime.reason, "eligible_limited_rollout")
})

test("limited rollout rejects missing, start-only, and ungrounded windows", () => {
  assert.equal(evaluateLimitedProactiveAttentionRollout({
    candidate: { ...candidate, expected_window: { start: null, end: null } },
    execution,
  }).rollout_rejection_reason, "missing_expected_window")
  assert.equal(evaluateLimitedProactiveAttentionRollout({
    candidate: { ...candidate, expected_window: { start: candidate.expected_window.start, end: null } },
    execution,
  }).rollout_rejection_reason, "incomplete_expected_window")
  assert.equal(evaluateLimitedProactiveAttentionRollout({
    candidate: { ...candidate, time_grounding: { source: "insufficient_time_evidence" } },
    execution,
  }).rollout_rejection_reason, "unsafe_time_grounding")
})

test("limited rollout rejects terminal, unsafe-history, and non-winning executions", () => {
  assert.equal(evaluateLimitedProactiveAttentionRollout({
    candidate: { ...candidate, state: "completed", attention_status: "closed" },
    execution,
  }).rollout_rejection_reason, "terminal_or_closed_event")
  assert.equal(evaluateLimitedProactiveAttentionRollout({
    candidate,
    execution,
    snapshotMetadata: {
      proactiveAttentionDiagnostics: [{
        matched_event_id: candidate.event_id,
        admission_result: "rejected",
        rejection_reason: "ambiguous_event_match",
      }],
    },
  }).rollout_rejection_reason, "unsafe_candidate_history")
  for (const reason of ["user_currently_active", "quiet_hours", "proactive_cooldown", "daily_proactive_limit"]) {
    const result = evaluateLimitedProactiveAttentionRollout({
      candidate,
      execution: { ...execution, would_send: false, arbitration: "neither", execution_reason: reason },
      now: "2026-08-28T08:00:00.000Z",
    })
    assert.equal(result.rollout_rejection_reason, reason)
  }
  assert.equal(evaluateLimitedProactiveAttentionRollout({
    candidate,
    execution: { ...execution, would_send: false, arbitration: "inactivity_wins", execution_reason: "inactivity_wins" },
    now: "2026-08-28T08:00:00.000Z",
  }).rollout_eligible, false)
})

test("API keeps OFF short-circuit before generation and uses task-id message idempotency", () => {
  const source = fs.readFileSync(new URL("../api/memory.js", import.meta.url), "utf8")
  const wakeup = source.slice(
    source.indexOf("async function executeProactiveAttentionWakeup"),
    source.indexOf("async function executeProactiveTask")
  )
  assert.ok(wakeup.indexOf("if (!sendEnabled || !execution.would_send || !rollout.rollout_eligible)") < wakeup.indexOf("generateProactiveAttentionMessage"))
  assert.match(source, /metadata->>proactiveTaskId/)
  assert.match(source, /ownsProactiveAttentionTaskClaim/)
  assert.match(source, /proactive_attention_send_attempt_count/)
  assert.match(source, /validateFinalProactiveAttentionRecheck/)
  assert.match(source, /proactiveAttentionCandidates: candidateSnapshotAfterProactiveSend/)
})

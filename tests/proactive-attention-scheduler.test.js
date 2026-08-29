import assert from "node:assert/strict"
import fs from "node:fs"
import {
  evaluateProactiveAttentionExecution,
  planProactiveAttentionWakeup,
} from "../lib/proactiveAttentionScheduler.js"
import { planExistingCandidateWakeupReconciliation } from "../lib/proactiveAttentionReconciliation.js"

function candidate(overrides = {}) {
  return {
    event_id: "event-1",
    description: "明天下午复查",
    source_message_ids: ["message-1"],
    state: "planned",
    expected_window: {
      start: "2026-08-29T07:00:00.000Z",
      end: "2026-08-29T10:00:00.000Z",
    },
    follow_up_profile: {
      result_expected: true,
      result_uncertainty: "meaningful",
      significance: "high",
      routine: false,
      immediate_continuation: false,
    },
    last_user_update: {
      message_id: "message-1",
      created_at: "2026-08-28T06:00:00.000Z",
    },
    attention_status: "open",
    last_proactive_mention: null,
    created_at: "2026-08-28T06:00:00.000Z",
    updated_at: "2026-08-28T06:00:00.000Z",
    ...overrides,
  }
}

// A. A future valuable event schedules at its window start and can become a
// shadow would-send decision without creating a message.
{
  const event = candidate()
  const wakeup = planProactiveAttentionWakeup(event, {
    now: "2026-08-28T07:00:00.000Z",
  })
  assert.equal(wakeup.scheduled, true)
  assert.equal(wakeup.reason, "future_window_start")
  assert.equal(wakeup.scheduled_for, event.expected_window.start)

  const execution = evaluateProactiveAttentionExecution({
    candidate: event,
    scheduledFor: wakeup.scheduled_for,
    now: "2026-08-29T07:05:00.000Z",
  })
  assert.equal(execution.gate_eligible, true)
  assert.equal(execution.would_send, true)
  assert.equal(execution.execution_mode, "shadow")
  assert.equal(execution.arbitration, "proactive_event_wins")
}

// B/C. An early completion or cancellation makes the old wake-up a hard no-op.
for (const [state, reason] of [["completed", "event_completed"], ["cancelled", "event_cancelled"]]) {
  const terminal = candidate({ state, attention_status: "closed" })
  const execution = evaluateProactiveAttentionExecution({
    candidate: terminal,
    scheduledFor: "2026-08-29T07:00:00.000Z",
    now: "2026-08-29T07:05:00.000Z",
  })
  assert.equal(execution.gate_reason, reason)
  assert.equal(execution.hard_rejection, true)
  assert.equal(execution.would_send, false)
}

// D. A changed future window produces a new deterministic evaluation time.
{
  const rescheduled = candidate({
    updated_at: "2026-08-28T08:00:00.000Z",
    expected_window: {
      start: "2026-08-30T08:00:00.000Z",
      end: "2026-08-30T10:00:00.000Z",
    },
  })
  const wakeup = planProactiveAttentionWakeup(rescheduled, {
    now: "2026-08-29T07:00:00.000Z",
  })
  assert.equal(wakeup.scheduled, true)
  assert.equal(wakeup.scheduled_for, "2026-08-30T08:00:00.000Z")
}

// E. A low-value routine event is rejected even when its window is future.
{
  const lowValue = candidate({
    follow_up_profile: {
      result_expected: false,
      result_uncertainty: "none",
      significance: "low",
      routine: true,
      immediate_continuation: true,
    },
  })
  const wakeup = planProactiveAttentionWakeup(lowValue, {
    now: "2026-08-28T07:00:00.000Z",
  })
  assert.equal(wakeup.scheduled, false)
  assert.equal(wakeup.reason, "immediate_routine_event")
}

// F. Recent user activity prevents an otherwise eligible interruption.
{
  const execution = evaluateProactiveAttentionExecution({
    candidate: candidate(),
    scheduledFor: "2026-08-29T07:00:00.000Z",
    now: "2026-08-29T07:05:00.000Z",
    userCurrentlyActive: true,
  })
  assert.equal(execution.execution_reason, "user_currently_active")
  assert.equal(execution.arbitration, "neither")
  assert.equal(execution.would_send, false)
}

// G. Collision diagnostics select exactly one winner.
{
  const proactiveWins = evaluateProactiveAttentionExecution({
    candidate: candidate(),
    scheduledFor: "2026-08-29T07:00:00.000Z",
    now: "2026-08-29T07:05:00.000Z",
    inactivityEligible: true,
  })
  assert.equal(proactiveWins.arbitration, "proactive_event_wins")

  const inactivityWins = evaluateProactiveAttentionExecution({
    candidate: candidate({ state: "completed", attention_status: "closed" }),
    scheduledFor: "2026-08-29T07:00:00.000Z",
    now: "2026-08-29T07:05:00.000Z",
    inactivityEligible: true,
  })
  assert.equal(inactivityWins.arbitration, "inactivity_wins")
  assert.equal(inactivityWins.would_send, false)
}

// H. Quiet hours, cooldown, and daily limit independently reject sending.
for (const [field, reason] of [
  ["quietHours", "quiet_hours"],
  ["cooldownActive", "proactive_cooldown"],
  ["dailyLimitReached", "daily_proactive_limit"],
]) {
  const execution = evaluateProactiveAttentionExecution({
    candidate: candidate(),
    scheduledFor: "2026-08-29T07:00:00.000Z",
    now: "2026-08-29T07:05:00.000Z",
    [field]: true,
  })
  assert.equal(execution.execution_reason, reason)
  assert.equal(execution.would_send, false)
}

// I. A duplicate execution with the same evidence yields the same decision.
{
  const input = {
    candidate: candidate(),
    scheduledFor: "2026-08-29T07:00:00.000Z",
    now: "2026-08-29T07:05:00.000Z",
    inactivityEligible: true,
  }
  assert.deepEqual(
    evaluateProactiveAttentionExecution(input),
    evaluateProactiveAttentionExecution(input)
  )
}

// J. No expected window means no invented wake-up time.
{
  const wakeup = planProactiveAttentionWakeup(candidate({
    expected_window: { start: null, end: null },
  }), { now: "2026-08-28T07:00:00.000Z" })
  assert.equal(wakeup.scheduled, false)
  assert.equal(wakeup.reason, "expected_window_missing")
  assert.equal(wakeup.scheduled_for, null)
}

// The production worker handles wake-ups before any message generation and
// persists a null message_id for Shadow execution.
{
  const memoryApi = fs.readFileSync(new URL("../api/memory.js", import.meta.url), "utf8")
  assert.match(memoryApi, /if \(task\.type === PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE\) \{\s*return executeProactiveAttentionWakeup\(task\)/)
  assert.match(memoryApi, /message_id: result\.shadowOnly \? null : result\.messageId/)
  assert.match(memoryApi, /onConflict: "user_id,type,source_type,source_id"/)
  assert.match(
    memoryApi,
    /select\("id,user_id,conversation_id,type,source_type,source_id,status,due_at,reason,payload,created_at"\)/,
  )
}

// Existing open candidates are reconciled without changing scheduler admission.
{
  const future = candidate()
  const missing = planExistingCandidateWakeupReconciliation({
    candidate: future,
    sourceMessageValid: true,
    now: "2026-08-28T07:00:00.000Z",
  })
  assert.equal(missing.action, "upsert")
  assert.equal(missing.scheduled_for, future.expected_window.start)

  const pendingTask = {
    status: "pending",
    due_at: missing.scheduled_for,
    payload: { candidate_updated_at: future.updated_at },
  }
  const duplicate = planExistingCandidateWakeupReconciliation({
    candidate: future,
    existingTask: pendingTask,
    sourceMessageValid: true,
    now: "2026-08-28T07:00:00.000Z",
  })
  assert.equal(duplicate.action, "none")
  assert.equal(duplicate.reason, "existing_pending_task")
  assert.deepEqual(
    planExistingCandidateWakeupReconciliation({
      candidate: future,
      existingTask: pendingTask,
      sourceMessageValid: true,
      now: "2026-08-28T07:00:00.000Z",
    }),
    duplicate,
  )

  for (const status of ["processing", "completed"]) {
    const existing = planExistingCandidateWakeupReconciliation({
      candidate: future,
      existingTask: {
        ...pendingTask,
        status,
        completed_at: status === "completed" ? "2026-08-28T07:05:00.000Z" : null,
      },
      sourceMessageValid: true,
      now: "2026-08-28T07:00:00.000Z",
    })
    assert.equal(existing.action, "none")
    assert.equal(existing.reason, `existing_${status}_task`)
  }
}

for (const blocked of [
  candidate({ state: "completed", attention_status: "closed" }),
  candidate({ state: "planned", attention_status: "closed" }),
  candidate({
    expected_window: {
      start: "2026-08-27T07:00:00.000Z",
      end: "2026-08-27T10:00:00.000Z",
    },
  }),
]) {
  const result = planExistingCandidateWakeupReconciliation({
    candidate: blocked,
    sourceMessageValid: true,
    now: "2026-08-28T07:00:00.000Z",
  })
  assert.equal(result.action, "none")
}

{
  const invalidProvenance = planExistingCandidateWakeupReconciliation({
    candidate: candidate(),
    sourceMessageValid: false,
    now: "2026-08-28T07:00:00.000Z",
  })
  assert.equal(invalidProvenance.action, "none")
  assert.equal(invalidProvenance.reason, "invalid_source_message")

  const invalidCandidateProvenance = planExistingCandidateWakeupReconciliation({
    candidate: candidate({ source_message_ids: ["different-message"] }),
    sourceMessageValid: true,
    now: "2026-08-28T07:00:00.000Z",
  })
  assert.equal(invalidCandidateProvenance.action, "none")
  assert.equal(invalidCandidateProvenance.reason, "invalid_candidate")

  const incompleteWindow = planExistingCandidateWakeupReconciliation({
    candidate: candidate({ expected_window: { start: "2026-08-29T07:00:00.000Z", end: null } }),
    sourceMessageValid: true,
    now: "2026-08-28T07:00:00.000Z",
  })
  assert.equal(incompleteWindow.action, "none")
  assert.equal(incompleteWindow.reason, "incomplete_expected_window")

  const lowValue = planExistingCandidateWakeupReconciliation({
    candidate: candidate({
      follow_up_profile: {
        result_expected: false,
        result_uncertainty: "none",
        significance: "medium",
        routine: false,
        immediate_continuation: false,
      },
    }),
    sourceMessageValid: true,
    now: "2026-08-28T07:00:00.000Z",
  })
  assert.equal(lowValue.action, "none")
  assert.equal(lowValue.reason, "not_worth_interrupting_silence")
}

{
  const rescheduled = candidate({
    updated_at: "2026-08-28T08:00:00.000Z",
    expected_window: {
      start: "2026-08-30T08:00:00.000Z",
      end: "2026-08-30T10:00:00.000Z",
    },
  })
  const result = planExistingCandidateWakeupReconciliation({
    candidate: rescheduled,
    existingTask: {
      status: "pending",
      due_at: "2026-08-29T07:00:00.000Z",
      payload: { candidate_updated_at: "2026-08-28T06:00:00.000Z" },
    },
    sourceMessageValid: true,
    now: "2026-08-29T07:00:00.000Z",
  })
  assert.equal(result.action, "reschedule")
  assert.equal(result.scheduled_for, "2026-08-30T08:00:00.000Z")

  const alreadyMentioned = planExistingCandidateWakeupReconciliation({
    candidate: candidate({
      last_proactive_mention: {
        message_id: "assistant-proactive-1",
        created_at: "2026-08-28T08:00:00.000Z",
      },
    }),
    sourceMessageValid: true,
    now: "2026-08-28T07:00:00.000Z",
  })
  assert.equal(alreadyMentioned.action, "none")
  assert.equal(alreadyMentioned.reason, "already_proactively_mentioned")
}

console.log("proactive attention scheduler tests passed")

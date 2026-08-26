import assert from "node:assert/strict"
import {
  PROACTIVE_ATTENTION_GATE_REASONS,
  evaluateProactiveAttention,
} from "../lib/proactiveAttentionGate.js"

const base = {
  event_id: "event-1",
  description: "明天处理一个现实安排",
  source_message_ids: ["message-1"],
  state: "planned",
  expected_window: {
    start: "2026-08-26T09:00:00.000Z",
    end: "2026-08-26T11:00:00.000Z",
  },
  last_user_update: {
    message_id: "message-1",
    created_at: "2026-08-26T08:00:00.000Z",
  },
  attention_status: "open",
  last_proactive_mention: null,
  created_at: "2026-08-26T08:00:00.000Z",
  updated_at: "2026-08-26T08:00:00.000Z",
}

function rejected(candidate, reason, options = {}) {
  const result = evaluateProactiveAttention(candidate, {
    now: "2026-08-26T10:00:00.000Z",
    ...options,
  })
  assert.equal(result.eligible_for_proactive_attention, false)
  assert.equal(result.reason, reason)
  assert.equal(result.hard_rejection, true)
}

rejected(null, PROACTIVE_ATTENTION_GATE_REASONS.EVENT_MISSING)
rejected({ ...base, source_message_ids: [] }, PROACTIVE_ATTENTION_GATE_REASONS.INVALID_SOURCE_PROVENANCE)
rejected({ ...base, state: "completed" }, PROACTIVE_ATTENTION_GATE_REASONS.EVENT_COMPLETED)
rejected({ ...base, state: "cancelled" }, PROACTIVE_ATTENTION_GATE_REASONS.EVENT_CANCELLED)
rejected({ ...base, attention_status: "closed" }, PROACTIVE_ATTENTION_GATE_REASONS.ATTENTION_CLOSED)
rejected(base, PROACTIVE_ATTENTION_GATE_REASONS.USER_ALREADY_UPDATED_RESULT, { userAlreadyUpdatedResult: true })
rejected(base, PROACTIVE_ATTENTION_GATE_REASONS.USER_REJECTED_TOPIC, { userRejectedTopic: true })
rejected({
  ...base,
  last_proactive_mention: { message_id: "assistant-1", created_at: "2026-08-26T09:30:00.000Z" },
}, PROACTIVE_ATTENTION_GATE_REASONS.ALREADY_PROACTIVELY_MENTIONED)
rejected(base, PROACTIVE_ATTENTION_GATE_REASONS.OUTSIDE_EXPECTED_WINDOW, {
  now: "2026-08-26T07:00:00.000Z",
})
rejected({ ...base, expected_window: { start: null, end: null } }, PROACTIVE_ATTENTION_GATE_REASONS.ATTENTION_EXPIRED, {
  now: "2026-09-04T08:00:00.000Z",
})
rejected({ ...base, expected_window: { start: null, end: null } }, PROACTIVE_ATTENTION_GATE_REASONS.STALE_CANDIDATE, {
  now: "2026-10-01T08:00:00.000Z",
})

{
  const result = evaluateProactiveAttention(base, { now: "2026-08-26T10:00:00.000Z" })
  assert.equal(result.event_id, "event-1")
  assert.equal(result.eligible_for_proactive_attention, true)
  assert.equal(result.reason, PROACTIVE_ATTENTION_GATE_REASONS.ELIGIBLE_SHADOW)
  assert.equal(result.hard_rejection, false)
  assert.equal(result.evaluated_at, "2026-08-26T10:00:00.000Z")
}

console.log("proactive attention gate tests passed")

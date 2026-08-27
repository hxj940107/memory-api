import assert from "node:assert/strict"
import {
  buildProactiveJudgeTimeAuthority,
  normalizeProactiveEventWindow,
} from "../lib/proactiveEventTemporalGrounding.js"

const messageAt = "2026-08-27T05:45:19.133Z" // 13:45 Asia/Shanghai

{
  const grounded = normalizeProactiveEventWindow({
    local_interpreted_window: {
      start: "2026-08-27T15:30:00",
      end: null,
    },
    time_grounding_source: "relative_to_user_message",
  }, { userMessageCreatedAt: messageAt }).proposal
  assert.equal(grounded.expected_window.start, "2026-08-27T07:30:00.000Z")
  assert.equal(grounded.expected_window.end, null)
  assert.equal(grounded.time_grounding.user_message_local_time, "2026-08-27T13:45:19")
}

{
  const nextAfternoon = normalizeProactiveEventWindow({
    local_interpreted_window: {
      start: "2026-08-28T14:00:00",
      end: "2026-08-28T18:00:00",
    },
    time_grounding_source: "relative_to_user_message",
  }, { userMessageCreatedAt: messageAt }).proposal
  assert.deepEqual(nextAfternoon.expected_window, {
    start: "2026-08-28T06:00:00.000Z",
    end: "2026-08-28T10:00:00.000Z",
  })
}

{
  const friday = normalizeProactiveEventWindow({
    local_interpreted_window: {
      start: "2026-08-28T08:00:00",
      end: "2026-08-28T12:00:00",
    },
    time_grounding_source: "relative_to_user_message",
  }, { userMessageCreatedAt: messageAt }).proposal
  assert.equal(friday.expected_window.start, "2026-08-28T00:00:00.000Z")
  assert.equal(friday.expected_window.end, "2026-08-28T04:00:00.000Z")
}

{
  const none = normalizeProactiveEventWindow({
    local_interpreted_window: { start: null, end: null },
    time_grounding_source: "insufficient_time_evidence",
  }, { userMessageCreatedAt: messageAt }).proposal
  assert.deepEqual(none.expected_window, { start: null, end: null })
}

{
  const reversed = normalizeProactiveEventWindow({
    local_interpreted_window: {
      start: "2026-08-28T18:00:00",
      end: "2026-08-28T14:00:00",
    },
  }, { userMessageCreatedAt: messageAt })
  assert.equal(reversed.errorCode, "event_proposal_invalid_window_order")
  assert.deepEqual(reversed.proposal.expected_window, { start: null, end: null })
}

{
  const authority = buildProactiveJudgeTimeAuthority({
    serverNow: "2026-08-27T05:46:00.000Z",
    userMessageCreatedAt: messageAt,
  })
  assert.equal(authority.timezone, "Asia/Shanghai")
  assert.equal(authority.current_shanghai_time, "2026-08-27T13:46:00")
  assert.equal(authority.current_user_message_shanghai_time, "2026-08-27T13:45:19")
}

console.log("proactive event temporal grounding tests passed")

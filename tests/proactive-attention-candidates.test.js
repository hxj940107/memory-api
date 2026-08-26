import assert from "node:assert/strict"
import {
  PROACTIVE_OPEN_CANDIDATE_LIMIT,
  applyProactiveEventProposal,
} from "../lib/proactiveAttentionCandidates.js"

function apply(candidates, {
  id,
  text,
  matchedEventId = null,
  state = "planned",
  eventId = `event-${id}`,
  source = "current_user_message",
  role = "user",
  now = `2026-08-26T0${id}:00:00.000Z`,
}) {
  return applyProactiveEventProposal({
    candidates,
    proposal: {
      action: "create_or_update",
      matched_event_id: matchedEventId,
      description: text,
      state,
      expected_window: {
        start: "2026-08-27T04:00:00.000Z",
        end: "2026-08-27T07:00:00.000Z",
      },
    },
    sourceMessage: {
      id: `message-${id}`,
      role,
      created_at: now,
    },
    conversationId: "conversation-1",
    candidateSource: source,
    createEventId: () => eventId,
    now: () => now,
  })
}

// Three differently worded user updates merge through a bounded existing ID,
// not through food keywords or message identity.
{
  const first = apply([], {
    id: 1,
    text: "明天带咖喱牛肉去公司吃",
    eventId: "event-curry",
  })
  const second = apply(first.candidates, {
    id: 2,
    text: "明天中午把之前准备的料理带到公司并给小C看",
    matchedEventId: "event-curry",
  })
  const third = apply(second.candidates, {
    id: 3,
    text: "料理已经放进冰箱，明天中午吃",
    matchedEventId: "event-curry",
  })

  assert.equal(third.candidates.length, 1)
  assert.equal(third.candidates[0].event_id, "event-curry")
  assert.deepEqual(third.candidates[0].source_message_ids, [
    "message-1",
    "message-2",
    "message-3",
  ])
  assert.equal(third.candidates[0].created_at, first.candidates[0].created_at)
  assert.equal(third.candidates[0].updated_at, "2026-08-26T03:00:00.000Z")
  assert.equal(third.diagnostics.merge_action, "merged_existing")
}

// Independent events remain independent when no existing ID is matched.
{
  const first = apply([], { id: 1, text: "明早去医院复查", eventId: "event-a" })
  const second = apply(first.candidates, { id: 2, text: "周末提交项目报告", eventId: "event-b" })
  assert.deepEqual(second.candidates.map(item => item.event_id), ["event-a", "event-b"])
}

// Terminal candidates cannot be reopened by a later ordinary proposal.
for (const terminalState of ["completed", "cancelled"]) {
  const terminal = apply([], {
    id: 1,
    text: "现实事件已经结束",
    state: terminalState,
    eventId: `event-${terminalState}`,
  })
  const attempted = apply(terminal.candidates, {
    id: 2,
    text: "普通后续消息试图重新打开",
    state: "planned",
    matchedEventId: `event-${terminalState}`,
  })
  assert.equal(attempted.candidates[0].state, terminalState)
  assert.equal(attempted.candidates[0].attention_status, "closed")
  assert.equal(attempted.diagnostics.merge_action, "terminal_not_reopened")
}

// Memory, Summary, and assistant messages cannot become candidate sources.
for (const source of ["dynamic_memory", "summary", "stable_memory", "core_memory"]) {
  const result = apply([], { id: 1, text: "外部上下文命中", source })
  assert.deepEqual(result.candidates, [])
  assert.equal(result.diagnostics.merge_action, "rejected_invalid_source")
}
{
  const result = apply([], { id: 1, text: "小C自己提到的话题", role: "assistant" })
  assert.deepEqual(result.candidates, [])
  assert.equal(result.diagnostics.merge_action, "rejected_invalid_source")
}

// An invented matched ID is rejected instead of being adopted or converted.
{
  const result = apply([], {
    id: 1,
    text: "模型返回了不存在的 ID",
    matchedEventId: "invented-by-model",
  })
  assert.deepEqual(result.candidates, [])
  assert.equal(result.diagnostics.merge_action, "rejected_invalid_match")
  assert.equal(result.diagnostics.matched_event_id, "invented-by-model")
}

// Source IDs are a unique, ordered union capped at the most recent eight.
{
  let result = apply([], { id: 1, text: "持续更新的现实事件", eventId: "event-union" })
  for (let id = 2; id <= 10; id += 1) {
    result = apply(result.candidates, {
      id,
      text: `现实事件第${id}次更新`,
      matchedEventId: "event-union",
      now: `2026-08-26T${String(id).padStart(2, "0")}:00:00.000Z`,
    })
  }
  assert.deepEqual(result.candidates[0].source_message_ids, [
    "message-3", "message-4", "message-5", "message-6",
    "message-7", "message-8", "message-9", "message-10",
  ])
}

// A fourth open candidate is rejected without evicting a live event.
{
  let candidates = []
  for (let id = 1; id <= PROACTIVE_OPEN_CANDIDATE_LIMIT; id += 1) {
    candidates = apply(candidates, {
      id,
      text: `独立现实事件${id}`,
      eventId: `event-${id}`,
    }).candidates
  }
  const rejected = apply(candidates, {
    id: 4,
    text: "第四个独立现实事件",
    eventId: "event-4",
    now: "2026-08-26T04:00:00.000Z",
  })
  assert.equal(rejected.candidates.length, PROACTIVE_OPEN_CANDIDATE_LIMIT)
  assert.equal(rejected.diagnostics.merge_action, "rejected_candidate_limit")
}

console.log("proactive attention candidate tests passed")

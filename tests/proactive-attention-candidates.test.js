import assert from "node:assert/strict"
import {
  PROACTIVE_OPEN_CANDIDATE_LIMIT,
  applyProactiveEventProposal,
  applyProactiveEventProposals,
} from "../lib/proactiveAttentionCandidates.js"
import { parseActiveContextJudgeOutput } from "../lib/activeContextJudgeOutput.js"

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
      source_message_id: `message-${id}`,
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

{
  const ids = ["event-lunch", "event-facial"]
  const result = applyProactiveEventProposals({
    candidates: [],
    proposals: ["周日中午和朋友吃饭", "周日下午做脸"].map(description => ({
      action: "create_or_update",
      matched_event_id: null,
      description,
      state: "planned",
      expected_window: { start: null, end: null },
      source_message_id: "message-multi",
    })),
    sourceMessage: { id: "message-multi", role: "user" },
    createEventId: () => ids.shift(),
  })
  assert.deepEqual(result.candidates.map(item => item.event_id), ["event-lunch", "event-facial"])
  assert.equal(result.diagnostics.filter(item => item.admission_result === "accepted").length, 2)
}

{
  const result = applyProactiveEventProposals({
    candidates: [],
    proposals: [
      { action: "create_or_update", description: "无来源事件", state: "planned", source_message_id: "wrong" },
      {
        action: "create_or_update",
        matched_event_id: null,
        description: "周五早上考试",
        state: "planned",
        expected_window: { start: null, end: null },
        source_message_id: "message-exam",
      },
    ],
    sourceMessage: { id: "message-exam", role: "user" },
    createEventId: () => "event-exam",
  })
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].event_id, "event-exam")
  assert.equal(result.diagnostics[0].rejection_reason, "rejected_invalid_source")
  assert.equal(result.diagnostics[1].admission_result, "accepted")
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

{
  const existing = apply([], {
    id: 1,
    text: "三点半在公司做雾化",
    eventId: "event-nebulizer",
  })
  const parsed = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: { items: [] },
    proactive_event_proposals: [{
      action: "update",
      matched_event_id: "event-nebulizer",
      description: "昨天做过一次，今天再做一次雾化",
      state: "planned",
      expected_window: { start: null, end: null },
      source_message_id: "message-2",
    }],
  }))
  const updated = applyProactiveEventProposal({
    candidates: existing.candidates,
    proposal: parsed.proactiveEventProposals[0],
    sourceMessage: {
      id: "message-2",
      role: "user",
      created_at: "2026-08-26T02:00:00.000Z",
    },
    createEventId: () => "must-not-create",
    now: () => "2026-08-26T02:00:00.000Z",
  })
  assert.equal(updated.diagnostics.merge_action, "merged_existing")
  assert.equal(updated.candidates.length, 1)
  assert.equal(updated.candidates[0].event_id, "event-nebulizer")
  assert.deepEqual(updated.candidates[0].source_message_ids, ["message-1", "message-2"])
  assert.equal(updated.candidates[0].last_user_update.message_id, "message-2")
}

console.log("proactive attention candidate tests passed")

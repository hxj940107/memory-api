import assert from "node:assert/strict"
import {
  PROACTIVE_OPEN_CANDIDATE_LIMIT,
  applyProactiveEventProposal,
  applyProactiveEventProposals,
  isOpenProactiveAttentionCandidate,
  normalizeProactiveAttentionCandidates,
} from "../lib/proactiveAttentionCandidates.js"
import { parseActiveContextJudgeOutput } from "../lib/activeContextJudgeOutput.js"
import { evaluateProactiveAttention } from "../lib/proactiveAttentionGate.js"

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
      content: text,
      created_at: now,
    },
    conversationId: "conversation-1",
    candidateSource: source,
    createEventId: () => eventId,
    now: () => now,
  })
}

function proposal({ messageId, description, state = "planned", matchedEventId = null }) {
  return {
    action: "create_or_update",
    matched_event_id: matchedEventId,
    description,
    state,
    expected_window: { start: null, end: null },
    source_message_id: messageId,
  }
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
    sourceMessage: {
      id: "message-multi",
      role: "user",
      content: "周日中午和朋友吃饭，周日下午做脸",
    },
    createEventId: () => ids.shift(),
  })
  assert.deepEqual(result.candidates.map(item => item.event_id), ["event-lunch", "event-facial"])
  assert.equal(result.diagnostics.filter(item => item.admission_result === "accepted").length, 2)
}

// A named completion is a lifecycle update even when all three open slots are occupied.
{
  let candidates = []
  for (const [id, text] of [[1, "下午三点半做雾化"], [2, "等待快递"], [3, "晚上整理材料"]]) {
    candidates = apply(candidates, { id, text, eventId: `event-${id}` }).candidates
  }
  const completed = apply(candidates, {
    id: 4,
    text: "做完雾化了",
    matchedEventId: "event-1",
    state: "completed",
    now: "2026-08-26T04:00:00.000Z",
  })
  const event = completed.candidates.find(item => item.event_id === "event-1")
  assert.equal(completed.diagnostics.merge_action, "merged_existing")
  assert.equal(completed.diagnostics.referent_check, "explicit_description_referent")
  assert.equal(event.state, "completed")
  assert.equal(event.attention_status, "closed")
  assert.deepEqual(event.source_message_ids, ["message-1", "message-4"])
  assert.equal(event.last_user_update.message_id, "message-4")
  assert.equal(event.updated_at, "2026-08-26T04:00:00.000Z")
  assert.equal(completed.candidates.filter(isOpenProactiveAttentionCandidate).length, 2)
  const gate = evaluateProactiveAttention(event, { now: "2026-08-26T04:01:00.000Z" })
  assert.equal(gate.eligible_for_proactive_attention, false)
  assert.equal(gate.reason, "event_completed")
  assert.equal(gate.hard_rejection, true)
}

// Production regression: a complete lifecycle proposal survives a truncated
// trailing Active Context section and still closes the original exam event.
{
  const existing = apply([], {
    id: 1,
    text: "周五早上考试",
    eventId: "event-friday-exam",
    now: "2026-08-27T01:00:00.000Z",
  })
  const completedProposal = {
    action: "update",
    matched_event_id: "event-friday-exam",
    description: "周五早上的考试已完成",
    state: "completed",
    local_interpreted_window: { start: null, end: null },
    time_grounding_source: "insufficient_time_evidence",
    source_message_id: "message-exam-done",
    follow_up_profile: {
      result_expected: false,
      result_uncertainty: "none",
      significance: "medium",
      routine: false,
      immediate_continuation: false,
    },
  }
  const raw = `{
    "proactive_event_proposals":${JSON.stringify([completedProposal])},
    "active_context":{"items":[{"topic":"考试后状态"`
  const parsed = parseActiveContextJudgeOutput(raw, { finishReason: "length" })
  assert.equal(parsed.diagnostics.status, "parse_failed")
  assert.equal(parsed.proactiveEventProposals.length, 1)
  assert.equal(parsed.proactiveEventProposals[0].action, "create_or_update")

  const completed = applyProactiveEventProposal({
    candidates: existing.candidates,
    proposal: parsed.proactiveEventProposals[0],
    sourceMessage: {
      id: "message-exam-done",
      role: "user",
      content: "考完试了！昨天没睡好，可能有点压力，但考完了！还不错",
      created_at: "2026-08-28T01:27:34.637Z",
    },
    recentUserSourceLedger: [
      { id: "message-1", role: "user" },
      { id: "message-exam-done", role: "user" },
    ],
    createEventId: () => "must-not-create",
    now: () => "2026-08-28T01:27:34.637Z",
  })
  const event = completed.candidates.find(item => item.event_id === "event-friday-exam")
  assert.equal(completed.diagnostics.merge_action, "merged_existing")
  assert.equal(event.event_id, "event-friday-exam")
  assert.deepEqual(event.source_message_ids, ["message-1", "message-exam-done"])
  assert.equal(event.state, "completed")
  assert.equal(event.attention_status, "closed")
  const gate = evaluateProactiveAttention(event, { now: "2026-08-28T01:28:00.000Z" })
  assert.equal(gate.reason, "event_completed")
  assert.equal(gate.hard_rejection, true)
}

// Existing updates run before new admissions, so one completion can release a slot in the same turn.
{
  let candidates = []
  for (let id = 1; id <= 3; id += 1) {
    candidates = apply(candidates, {
      id,
      text: id === 1 ? "下午做雾化" : `独立现实事件${id}`,
      eventId: `event-${id}`,
    }).candidates
  }
  const ids = ["event-new"]
  const result = applyProactiveEventProposals({
    candidates,
    proposals: [
      proposal({ messageId: "message-4", description: "明天准备新的现实事件" }),
      proposal({ messageId: "message-4", description: "下午雾化已完成", state: "completed", matchedEventId: "event-1" }),
    ],
    sourceMessage: {
      id: "message-4",
      role: "user",
      content: "做完雾化了，明天准备新的现实事件",
      created_at: "2026-08-26T04:00:00.000Z",
    },
    createEventId: () => ids.shift(),
    now: () => "2026-08-26T04:00:00.000Z",
  })
  assert.equal(result.diagnostics[0].merge_action, "created")
  assert.equal(result.diagnostics[1].merge_action, "merged_existing")
  assert.equal(result.candidates.find(item => item.event_id === "event-1").state, "completed")
  assert.equal(result.candidates.find(item => item.event_id === "event-new").state, "planned")
  assert.equal(result.candidates.filter(isOpenProactiveAttentionCandidate).length, 3)
}

// A generic short completion can match only one uniquely recent real user referent.
{
  const older = apply([], { id: 1, text: "中午吃饭和午休", eventId: "event-lunch" })
  const recent = apply(older.candidates, {
    id: 2,
    text: "七点做明天的午饭",
    eventId: "event-tomorrow-lunch",
    now: "2026-08-26T02:00:00.000Z",
  })
  const completed = applyProactiveEventProposal({
    candidates: recent.candidates,
    proposal: proposal({
      messageId: "message-3",
      description: "七点准备明天午饭的事件已完成",
      state: "completed",
      matchedEventId: "event-tomorrow-lunch",
    }),
    sourceMessage: {
      id: "message-3", role: "user", content: "做好啦",
      created_at: "2026-08-26T02:30:00.000Z",
    },
    recentUserSourceLedger: [
      { id: "message-1", role: "user" },
      { id: "message-2", role: "user" },
      { id: "message-3", role: "user" },
    ],
    now: () => "2026-08-26T02:30:00.000Z",
  })
  assert.equal(completed.diagnostics.merge_action, "merged_existing")
  assert.equal(completed.diagnostics.referent_check, "unique_recent_user_referent")
  assert.equal(completed.candidates.find(item => item.event_id === "event-tomorrow-lunch").state, "completed")
  assert.equal(completed.candidates.find(item => item.event_id === "event-lunch").state, "planned")
}

// Two events introduced together make a generic completion ambiguous; no merge is safer.
{
  const ids = ["event-a", "event-b"]
  const existing = applyProactiveEventProposals({
    candidates: [],
    proposals: [
      proposal({ messageId: "message-both", description: "现实事件甲" }),
      proposal({ messageId: "message-both", description: "现实事件乙" }),
    ],
    sourceMessage: {
      id: "message-both", role: "user", content: "稍后做现实事件甲和现实事件乙",
      created_at: "2026-08-26T02:00:00.000Z",
    },
    createEventId: () => ids.shift(),
    now: () => "2026-08-26T02:00:00.000Z",
  })
  const ambiguous = applyProactiveEventProposal({
    candidates: existing.candidates,
    proposal: proposal({
      messageId: "message-done",
      description: "现实事件甲已完成",
      state: "completed",
      matchedEventId: "event-a",
    }),
    sourceMessage: {
      id: "message-done", role: "user", content: "做好啦",
      created_at: "2026-08-26T02:30:00.000Z",
    },
    recentUserSourceLedger: [
      { id: "message-both", role: "user" },
      { id: "message-done", role: "user" },
    ],
  })
  assert.equal(ambiguous.diagnostics.merge_action, "ambiguous_event_match")
  assert.equal(ambiguous.candidates.find(item => item.event_id === "event-a").state, "planned")
}

// Closed/terminal candidates remain in the snapshot but do not consume open capacity.
{
  const terminal = apply([], { id: 1, text: "已结束的事件", state: "completed", eventId: "event-closed" })
  let candidates = terminal.candidates
  for (let id = 2; id <= 4; id += 1) {
    candidates = apply(candidates, { id, text: `开放事件${id}`, eventId: `event-${id}` }).candidates
  }
  assert.equal(normalizeProactiveAttentionCandidates(candidates).some(item => item.event_id === "event-closed"), true)
  assert.equal(candidates.filter(isOpenProactiveAttentionCandidate).length, 3)
  const rejected = apply(candidates, { id: 5, text: "再来一个开放事件", eventId: "event-5" })
  assert.equal(rejected.diagnostics.merge_action, "rejected_candidate_limit")
}

// Missing message timestamps remain null instead of becoming epoch or processing time.
{
  const result = applyProactiveEventProposal({
    candidates: [],
    proposal: proposal({ messageId: "message-no-time", description: "无时间来源事件" }),
    sourceMessage: { id: "message-no-time", role: "user", content: "之后有件事" },
    createEventId: () => "event-no-time",
    now: () => "2026-08-26T04:00:00.000Z",
  })
  assert.equal(result.candidates[0].last_user_update.created_at, null)
  assert.notEqual(result.candidates[0].last_user_update.created_at, "1970-01-01T00:00:00.000Z")
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
    sourceMessage: {
      id: "message-exam",
      role: "user",
      content: "周五早上考试",
    },
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
      content: "昨天做了一次，今天再去做一次雾化",
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

// Production regression: a symptom update does not prove that a later
// treatment event has already completed.
{
  const existing = apply([], {
    id: 1,
    text: "今天下午再去做一次雾化",
    eventId: "event-nebulizer",
  })
  const result = applyProactiveEventProposal({
    candidates: existing.candidates,
    proposal: {
      ...proposal({
        messageId: "message-symptom",
        description: "下午雾化治疗已经完成",
        state: "completed",
        matchedEventId: "event-nebulizer",
      }),
      source_evidence: "好像也没什么不舒服了",
    },
    sourceMessage: {
      id: "message-symptom",
      role: "user",
      content: "嗯，好像也没什么不舒服了",
      created_at: "2026-08-26T02:30:00.000Z",
    },
  })
  assert.equal(result.diagnostics.merge_action, "unsupported_terminal_transition")
  assert.equal(result.diagnostics.admission_reason, "unsupported_terminal_transition")
  assert.equal(result.candidates[0].state, "planned")
  assert.equal(result.candidates[0].attention_status, "open")
}

// Production regression: unrelated current text cannot recreate a terminal
// event merely because that event remains visible in structured context.
{
  const terminal = apply([], {
    id: 1,
    text: "下午雾化治疗",
    state: "completed",
    eventId: "event-nebulizer",
  })
  const result = applyProactiveEventProposal({
    candidates: terminal.candidates,
    proposal: {
      ...proposal({
        messageId: "message-lunch-done",
        description: "下午雾化治疗",
      }),
      source_evidence: "吃完了",
    },
    sourceMessage: {
      id: "message-lunch-done",
      role: "user",
      content: "吃完了！",
      created_at: "2026-08-26T03:00:00.000Z",
    },
    createEventId: () => "must-not-create",
  })
  assert.equal(result.diagnostics.merge_action, "duplicate_terminal_recreation")
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].event_id, "event-nebulizer")
  assert.equal(result.candidates[0].state, "completed")
}

// The already verified short, uniquely-referential eating lifecycle remains intact.
{
  const existing = apply([], {
    id: 1,
    text: "一会儿去吃饭",
    eventId: "event-eating",
  })
  const result = applyProactiveEventProposal({
    candidates: existing.candidates,
    proposal: {
      ...proposal({
        messageId: "message-eaten",
        description: "一会儿去吃饭",
        state: "completed",
        matchedEventId: "event-eating",
      }),
      source_evidence: "吃完了",
    },
    sourceMessage: {
      id: "message-eaten",
      role: "user",
      content: "吃完了！",
      created_at: "2026-08-26T01:30:00.000Z",
    },
    recentUserSourceLedger: [
      { id: "message-1", role: "user" },
      { id: "message-eaten", role: "user" },
    ],
    now: () => "2026-08-26T01:30:00.000Z",
  })
  const event = result.candidates[0]
  assert.equal(event.event_id, "event-eating")
  assert.deepEqual(event.source_message_ids, ["message-1", "message-eaten"])
  assert.equal(event.state, "completed")
  assert.equal(event.attention_status, "closed")
  const gate = evaluateProactiveAttention(event, { now: "2026-08-26T01:31:00.000Z" })
  assert.equal(gate.reason, "event_completed")
  assert.equal(gate.hard_rejection, true)
}

// Explicit cancellation and rescheduling keep the existing event identity.
{
  const existing = apply([], {
    id: 1,
    text: "下午去做雾化",
    eventId: "event-nebulizer",
  })
  const cancelled = applyProactiveEventProposal({
    candidates: existing.candidates,
    proposal: proposal({
      messageId: "message-cancel",
      description: "下午去做雾化",
      state: "cancelled",
      matchedEventId: "event-nebulizer",
    }),
    sourceMessage: {
      id: "message-cancel",
      role: "user",
      content: "下午雾化不去了",
      created_at: "2026-08-26T02:00:00.000Z",
    },
  })
  assert.equal(cancelled.candidates[0].event_id, "event-nebulizer")
  assert.equal(cancelled.candidates[0].state, "cancelled")
  assert.equal(cancelled.candidates[0].attention_status, "closed")

  const rescheduled = applyProactiveEventProposal({
    candidates: existing.candidates,
    proposal: proposal({
      messageId: "message-reschedule",
      description: "雾化改到明天下午",
      state: "planned",
      matchedEventId: "event-nebulizer",
    }),
    sourceMessage: {
      id: "message-reschedule",
      role: "user",
      content: "雾化改到明天下午",
      created_at: "2026-08-26T02:00:00.000Z",
    },
  })
  assert.equal(rescheduled.candidates.length, 1)
  assert.equal(rescheduled.candidates[0].event_id, "event-nebulizer")
  assert.equal(rescheduled.diagnostics.admission_reason, "accepted_existing_update")
}

// A terminal event stays closed on unrelated text, while an explicitly stated
// new occurrence may receive a fresh identity and real current provenance.
{
  const terminal = apply([], {
    id: 1,
    text: "今天下午做雾化",
    state: "completed",
    eventId: "event-nebulizer-old",
  })
  const unrelated = applyProactiveEventProposal({
    candidates: terminal.candidates,
    proposal: proposal({
      messageId: "message-unrelated",
      description: "今天下午做雾化",
    }),
    sourceMessage: {
      id: "message-unrelated",
      role: "user",
      content: "刚吃完饭",
      created_at: "2026-08-26T03:00:00.000Z",
    },
    createEventId: () => "must-not-create",
  })
  assert.equal(unrelated.diagnostics.merge_action, "duplicate_terminal_recreation")

  const nextOccurrence = applyProactiveEventProposal({
    candidates: terminal.candidates,
    proposal: proposal({
      messageId: "message-next-occurrence",
      description: "明天下午再做一次雾化",
    }),
    sourceMessage: {
      id: "message-next-occurrence",
      role: "user",
      content: "明天下午还要再去做一次雾化",
      created_at: "2026-08-26T03:10:00.000Z",
    },
    createEventId: () => "event-nebulizer-new",
  })
  assert.equal(nextOccurrence.diagnostics.admission_reason, "accepted_new_event")
  assert.equal(nextOccurrence.candidates.some(item => (
    item.event_id === "event-nebulizer-new" && item.state === "planned"
  )), true)
  assert.deepEqual(
    nextOccurrence.candidates.find(item => item.event_id === "event-nebulizer-new").source_message_ids,
    ["message-next-occurrence"]
  )
}

console.log("proactive attention candidate tests passed")

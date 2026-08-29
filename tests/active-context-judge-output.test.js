import assert from "node:assert/strict"
import { parseActiveContextJudgeOutput } from "../lib/activeContextJudgeOutput.js"
import { applyProactiveEventProposal } from "../lib/proactiveAttentionCandidates.js"

const activeContext = {
  items: [{
    topic: "周五考试",
    context: "她周五早上参加公司知识考试",
    status: "active",
    kind: "plan",
    source_message_id: "message-exam",
    last_referenced_message_id: "message-exam",
  }],
}
const validProposal = {
  action: "create_or_update",
  matched_event_id: null,
  description: "周五早上的公司知识考试",
  state: "planned",
  expected_window: { start: null, end: null },
  source_message_id: "message-exam",
}

{
  const update = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: activeContext,
    proactive_event_proposals: [{
      ...validProposal,
      action: "update",
      matched_event_id: "event-nebulizer",
      source_message_id: "message-nebulizer-update",
      user_update: {
        kind: "planned",
        explicitness: "explicit",
        evidence_text: "三点再去",
        time_evidence_text: "三点",
      },
    }],
  }))
  assert.equal(update.proactiveEventProposals[0].action, "create_or_update")
  assert.equal(update.proactiveEventProposals[0].raw_action, "update")
  assert.equal(update.diagnostics.proposal_results[0].normalized_action, "create_or_update")

  const create = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: activeContext,
    proactive_event_proposals: [{ ...validProposal, action: "create" }],
  }))
  assert.equal(create.proactiveEventProposals[0].action, "create_or_update")

  const invalidUpdate = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: activeContext,
    proactive_event_proposals: [{ ...validProposal, action: "update", matched_event_id: null }],
  }))
  assert.equal(invalidUpdate.proactiveEventProposals.length, 0)
  assert.equal(invalidUpdate.diagnostics.proposal_results[0].rejection_reason, "event_proposal_update_requires_match")

  const invalidCreate = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: activeContext,
    proactive_event_proposals: [{ ...validProposal, action: "create", matched_event_id: "existing" }],
  }))
  assert.equal(invalidCreate.proactiveEventProposals.length, 0)
  assert.equal(invalidCreate.diagnostics.proposal_results[0].rejection_reason, "event_proposal_create_cannot_match")
}
const validOutput = JSON.stringify({
  active_context: activeContext,
  proactive_event_proposals: [validProposal],
})

{
  const parsed = parseActiveContextJudgeOutput(JSON.stringify({
    p: [{
      a: "u",
      id: "event-exam",
      d: "周五早上的公司知识考试",
      s: "c",
      w: ["2026-08-29T09:00:00", null],
      g: "e",
      src: "message-exam-completed",
      ev: "考试已完成",
      u: ["c", "e", "考试已完成", null],
      f: [true, "n", "m", false, false],
    }],
    c: {
      i: [{
        t: "周五考试",
        c: "她周五早上参加公司知识考试",
        s: "r",
        k: "p",
        src: "message-exam",
        ref: "message-exam-completed",
        e: "考试已完成",
      }],
      m: [],
    },
  }))
  assert.equal(parsed.diagnostics.status, "parsed")
  assert.equal(parsed.diagnostics.output_format, "compact_v1")
  assert.ok(parsed.diagnostics.raw_output_chars > 0)
  assert.equal(parsed.proactiveEventProposals[0].action, "create_or_update")
  assert.equal(parsed.proactiveEventProposals[0].raw_action, "update")
  assert.equal(parsed.proactiveEventProposals[0].state, "completed")
  assert.equal(parsed.proactiveEventProposals[0].matched_event_id, "event-exam")
  assert.equal(parsed.proactiveEventProposals[0].user_update.kind, "completed")
  assert.equal(parsed.proactiveEventProposals[0].user_update.explicitness, "explicit")
  assert.equal(parsed.proactiveEventProposals[0].local_interpreted_window.start, "2026-08-29T09:00:00")
  assert.equal(parsed.activeContext.items[0].status, "resolved")
}

{
  const parsed = parseActiveContextJudgeOutput(JSON.stringify({
    p: [{
      a: "u",
      id: "event-exam",
      s: "c",
      w: [null, null],
      g: "i",
      u: ["c", "e", "做完了", null],
      f: [true, "n", "m", false, false],
    }],
    c: { i: [], m: [] },
  }), {
    sourceMessageId: "message-current",
    existingCandidates: [{
      event_id: "event-exam",
      description: "周五早上的公司知识考试",
    }],
  })
  assert.equal(parsed.diagnostics.status, "parsed")
  assert.equal(parsed.proactiveEventProposals[0].source_message_id, "message-current")
  assert.equal(parsed.proactiveEventProposals[0].description, "周五早上的公司知识考试")
  assert.equal(parsed.proactiveEventProposals[0].source_evidence, "做完了")
}

{
  const parsed = parseActiveContextJudgeOutput(validOutput)
  assert.equal(parsed.diagnostics.status, "parsed")
  assert.equal(parsed.activeContext.items[0].topic, "周五考试")
  assert.equal(parsed.proactiveEventProposals[0].state, "planned")
}

{
  const parsed = parseActiveContextJudgeOutput(`\`\`\`json\n${validOutput}\n\`\`\``)
  assert.equal(parsed.diagnostics.status, "parsed")
}

{
  const parsed = parseActiveContextJudgeOutput(`判断如下：\n${validOutput}\n以上。`)
  assert.equal(parsed.diagnostics.status, "parsed")
}

{
  const withTrailingCommas = validOutput
    .replace('"items":[{', '"items":[{')
    .replace('}],"proactive_event_proposal"', '}],"proactive_event_proposal"')
    .replace('"end":null}}', '"end":null,},}')
  const parsed = parseActiveContextJudgeOutput(withTrailingCommas)
  assert.equal(parsed.diagnostics.status, "parsed")
}

{
  const malformed = `{
    "active_context": ${JSON.stringify(activeContext)},
    "proactive_event_proposal": {"action":"create_or_update","description":"考试"`
  const parsed = parseActiveContextJudgeOutput(malformed)
  assert.equal(parsed.diagnostics.status, "parse_failed")
  assert.match(parsed.diagnostics.error_code, /proactive_event_proposal/)
  assert.match(parsed.diagnostics.raw_output_summary, /active_context/)
  assert.equal(parsed.activeContext.items[0].topic, "周五考试")
  assert.deepEqual(parsed.proactiveEventProposals, [])
}

{
  const parsed = parseActiveContextJudgeOutput(validOutput.slice(0, -10), {
    finishReason: "length",
  })
  assert.equal(parsed.diagnostics.status, "parse_failed")
  assert.match(parsed.diagnostics.error_code, /output_truncated/)
}

{
  const completedProposal = {
    ...validProposal,
    action: "update",
    matched_event_id: "event-exam",
    description: "周五早上的公司知识考试已完成",
    state: "completed",
    source_message_id: "message-exam-completed",
    user_update: {
      kind: "completed",
      explicitness: "explicit",
      evidence_text: "考试已完成",
      time_evidence_text: null,
    },
  }
  const proposalFirstActiveTruncated = `{
    "proactive_event_proposals":${JSON.stringify([completedProposal])},
    "active_context":{"items":[{"topic":"截断中的事项"`
  const parsed = parseActiveContextJudgeOutput(proposalFirstActiveTruncated, {
    finishReason: "length",
  })
  assert.equal(parsed.diagnostics.status, "parse_failed")
  assert.equal(parsed.diagnostics.top_level_error_code, "json_object_missing")
  assert.match(parsed.diagnostics.error_code, /output_truncated/)
  assert.equal(parsed.activeContext, null)
  assert.equal(parsed.proactiveEventProposals.length, 1)
  assert.equal(parsed.proactiveEventProposals[0].state, "completed")
  assert.equal(parsed.proactiveEventProposals[0].matched_event_id, "event-exam")
}

{
  const proposalItselfTruncated = `{
    "proactive_event_proposals":[{"action":"update","matched_event_id":"event-exam"`
  const parsed = parseActiveContextJudgeOutput(proposalItselfTruncated, {
    finishReason: "length",
  })
  assert.equal(parsed.diagnostics.status, "parse_failed")
  assert.deepEqual(parsed.proactiveEventProposals, [])
  assert.match(parsed.diagnostics.proactive_event_proposal_error_code, /missing/)
}

{
  const malformedProposalWithCompleteActive = JSON.stringify({
    proactive_event_proposals: { invalid: true },
    active_context: activeContext,
  })
  const parsed = parseActiveContextJudgeOutput(malformedProposalWithCompleteActive)
  assert.equal(parsed.diagnostics.status, "parse_failed")
  assert.equal(parsed.activeContext.items[0].topic, "周五考试")
  assert.deepEqual(parsed.proactiveEventProposals, [])
  assert.equal(
    parsed.diagnostics.proactive_event_proposal_error_code,
    "proactive_event_proposals_invalid_shape",
  )
}

{
  const fourProposals = parseActiveContextJudgeOutput(JSON.stringify({
    proactive_event_proposals: Array.from({ length: 4 }, (_, index) => ({
      ...validProposal,
      description: `现实事件${index + 1}`,
    })),
    active_context: activeContext,
  }))
  assert.equal(fourProposals.diagnostics.proposal_count, 4)
  assert.equal(fourProposals.proactiveEventProposals.length, 3)
}

{
  const maximumActiveItems = parseActiveContextJudgeOutput(JSON.stringify({
    proactive_event_proposals: [],
    active_context: {
      items: Array.from({ length: 4 }, (_, index) => ({
        topic: `事项${index + 1}`,
        context: `事项${index + 1}的必要上下文`,
        status: "active",
        kind: "plan",
        source_message_id: `source-${index + 1}`,
        last_referenced_message_id: `source-${index + 1}`,
        source_evidence: `证据${index + 1}`,
      })),
    },
  }))
  assert.equal(maximumActiveItems.diagnostics.status, "parsed")
  assert.equal(maximumActiveItems.activeContext.items.length, 4)
}

{
  const parsed = parseActiveContextJudgeOutput("不是 JSON")
  assert.equal(parsed.diagnostics.status, "parse_failed")
  assert.equal(parsed.activeContext, null)
  assert.deepEqual(parsed.proactiveEventProposals, [])
}

{
  const parsed = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: activeContext,
    proactive_event_proposals: [{ ...validProposal, state: "future_done" }],
  }))
  assert.equal(parsed.activeContext.items[0].topic, "周五考试")
  assert.deepEqual(parsed.proactiveEventProposals, [])
  assert.equal(parsed.diagnostics.proposal_results[0].rejection_reason, "event_proposal_invalid_state")
}

{
  const missingEvidence = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: activeContext,
    proactive_event_proposals: [{
      ...validProposal,
      action: "update",
      matched_event_id: "event-exam",
    }],
  }))
  assert.equal(missingEvidence.proactiveEventProposals.length, 0)
  assert.equal(
    missingEvidence.diagnostics.proposal_results[0].rejection_reason,
    "event_proposal_existing_update_missing_evidence"
  )
}

{
  const parsed = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: activeContext,
    proactive_event_proposals: [{
      ...validProposal,
      matched_event_id: "invented-id",
      user_update: {
        kind: "planned",
        explicitness: "explicit",
        evidence_text: "周五早上考试",
        time_evidence_text: null,
      },
    }],
  }))
  const applied = applyProactiveEventProposal({
    candidates: [],
    proposal: parsed.proactiveEventProposals[0],
    sourceMessage: { id: "message-exam", role: "user" },
    createEventId: () => "must-not-be-created",
  })
  assert.equal(applied.diagnostics.merge_action, "rejected_invalid_match")
  assert.deepEqual(applied.candidates, [])
}

{
  const parsed = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: activeContext,
    proactive_event_proposals: [
      { ...validProposal, state: "not-a-state" },
      { ...validProposal, description: "周日中午和朋友吃饭" },
    ],
  }))
  assert.equal(parsed.diagnostics.status, "parsed")
  assert.equal(parsed.diagnostics.proposal_count, 2)
  assert.equal(parsed.diagnostics.parsed_proposal_count, 1)
  assert.equal(parsed.proactiveEventProposals[0].description, "周日中午和朋友吃饭")
}

for (const [messageId, descriptions] of [
  ["message-exam", ["周五早上考试"]],
  ["message-sunday", ["周日中午和朋友吃饭", "周日下午做脸"]],
  ["message-work", ["明天早上交销量表", "明天做客户信息统计"]],
]) {
  const parsed = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: { items: [] },
    proactive_event_proposals: descriptions.map(description => ({
      action: "create_or_update",
      matched_event_id: null,
      description,
      state: "planned",
      expected_window: { start: null, end: null },
      source_message_id: messageId,
    })),
  }))
  assert.deepEqual(parsed.proactiveEventProposals.map(item => item.description), descriptions)
}

for (const message of ["宝宝抱抱", "我去洗澡等会回来"]) {
  const parsed = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: { items: [] },
    proactive_event_proposals: [],
  }))
  assert.equal(typeof message, "string")
  assert.deepEqual(parsed.proactiveEventProposals, [])
}

console.log("active context judge output tests passed")

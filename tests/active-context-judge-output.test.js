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
}
const validOutput = JSON.stringify({
  active_context: activeContext,
  proactive_event_proposal: validProposal,
})

{
  const parsed = parseActiveContextJudgeOutput(validOutput)
  assert.equal(parsed.diagnostics.status, "parsed")
  assert.equal(parsed.activeContext.items[0].topic, "周五考试")
  assert.equal(parsed.proactiveEventProposal.state, "planned")
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
  assert.equal(parsed.proactiveEventProposal, null)
}

{
  const parsed = parseActiveContextJudgeOutput(validOutput.slice(0, -10), {
    finishReason: "length",
  })
  assert.equal(parsed.diagnostics.status, "parse_failed")
  assert.match(parsed.diagnostics.error_code, /output_truncated/)
}

{
  const parsed = parseActiveContextJudgeOutput("不是 JSON")
  assert.equal(parsed.diagnostics.status, "parse_failed")
  assert.equal(parsed.activeContext, null)
  assert.equal(parsed.proactiveEventProposal, null)
}

{
  const parsed = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: activeContext,
    proactive_event_proposal: { ...validProposal, state: "future_done" },
  }))
  assert.equal(parsed.activeContext.items[0].topic, "周五考试")
  assert.equal(parsed.proactiveEventProposal, null)
  assert.equal(
    parsed.diagnostics.proactive_event_proposal_error_code,
    "event_proposal_invalid_state"
  )
}

{
  const parsed = parseActiveContextJudgeOutput(JSON.stringify({
    active_context: activeContext,
    proactive_event_proposal: { ...validProposal, matched_event_id: "invented-id" },
  }))
  const applied = applyProactiveEventProposal({
    candidates: [],
    proposal: parsed.proactiveEventProposal,
    sourceMessage: { id: "message-current", role: "user" },
    createEventId: () => "must-not-be-created",
  })
  assert.equal(applied.diagnostics.merge_action, "rejected_invalid_match")
  assert.deepEqual(applied.candidates, [])
}

console.log("active context judge output tests passed")

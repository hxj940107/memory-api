import assert from "node:assert/strict"
import {
  completeJudgePrefilterShadow,
  evaluateJudgePrefilterShadow,
} from "../lib/judgePrefilterShadow.js"

const openCandidate = {
  event_id: "event-1",
  state: "planned",
  attention_status: "open",
}

for (const message of ["做完了", "取消了", "三点再去", "没呢", "明天吧"]) {
  const result = evaluateJudgePrefilterShadow({
    message,
    previousProactiveCandidates: [openCandidate],
  })
  assert.equal(result.would_skip, false, message)
  assert.equal(result.reason, "open_candidate_present")
}

{
  const result = evaluateJudgePrefilterShadow({
    message: "没呢",
    contextualAssistantMessage: {
      is_immediately_previous: true,
      content: "雾化做完了吗？",
    },
  })
  assert.equal(result.would_skip, false)
  assert.equal(result.reason, "assistant_question_context")
}

{
  assert.deepEqual(
    evaluateJudgePrefilterShadow({ message: "🙂" }),
    { would_skip: true, reason: "pure_reaction" }
  )
  assert.deepEqual(
    evaluateJudgePrefilterShadow({ message: "嗯嗯" }),
    { would_skip: true, reason: "closed_acknowledgement" }
  )
}

{
  const result = completeJudgePrefilterShadow({
    prefilter: { would_skip: true, reason: "closed_acknowledgement" },
    previousActiveContext: { items: [] },
    nextActiveContext: { items: [{ topic: "新计划", context: "她明天出门" }] },
    mergeDiagnostics: { proposals: [] },
  })
  assert.equal(result.active_context_changed, true)
  assert.equal(result.dangerous_false_skip, true)
}

{
  const result = completeJudgePrefilterShadow({
    prefilter: { would_skip: true, reason: "pure_reaction" },
    previousActiveContext: { items: [] },
    nextActiveContext: { items: [] },
    mergeDiagnostics: { proposals: [] },
  })
  assert.equal(result.dangerous_false_skip, false)
}

console.log("judge prefilter shadow tests passed")

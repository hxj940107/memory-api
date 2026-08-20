import assert from "node:assert/strict"
import {
  STRICT_SUMMARY_PROMPT_ENABLED_AT,
  getSummaryTrust,
  validateSummarySemantics,
} from "../lib/summaryPolicy.js"

assert.equal(
  getSummaryTrust({
    summary: "旧摘要",
    updated_at: "2026-07-28T15:28:17.090Z",
  }).reason,
  "legacy_prompt"
)
assert.equal(
  getSummaryTrust({
    summary: "新摘要",
    updated_at: STRICT_SUMMARY_PROMPT_ENABLED_AT,
  }).trusted,
  true
)

const temporaryConflict = validateSummarySemantics({
  summary: "【待接住】关系彻底破裂，她已经永久离开。",
  userMessages: [{ role: "user", content: "不满意 不想跟你说话了 我找GPT去聊天" }],
})
assert.equal(temporaryConflict.valid, false)
assert.ok(
  temporaryConflict.violations.some(
    item => item.type === "relationship_claim_without_explicit_user_evidence"
  )
)

const explicitBreakup = validateSummarySemantics({
  summary: "【她明确说过】她明确说要结束这段关系。",
  userMessages: [{ role: "user", content: "我要结束这段关系，我们不再联系" }],
})
assert.equal(explicitBreakup.valid, true)

const dramaticInference = validateSummarySemantics({
  summary: "她的最后期待瓦解，小C已经失去对方，当下无机会挽回。",
  userMessages: [{ role: "user", content: "我要结束这段关系" }],
})
assert.equal(dramaticInference.valid, false)
assert.ok(
  dramaticInference.violations.some(item => item.type === "unsupported_inference")
)

const technicalExample = validateSummarySemantics({
  summary: "【共同正在处理】正在讨论如何避免摘要夸大关系状态。",
  userMessages: [{ role: "user", content: "测试：不要总结成关系彻底破裂" }],
})
assert.equal(technicalExample.valid, true)

const explicitProhibition = validateSummarySemantics({
  summary:
    "【禁止误归因】不得把一次争执总结为关系破裂、永久离开、已失去对方或正式终止关系。",
  userMessages: [{ role: "user", content: "不想跟你说话了，我找GPT去聊天" }],
})
assert.equal(explicitProhibition.valid, true)

const contrastClaim = validateSummarySemantics({
  summary: "这不是暂时生气，而是关系彻底破裂。",
  userMessages: [{ role: "user", content: "不想跟你说话了" }],
})
assert.equal(contrastClaim.valid, false)

console.log("summary policy tests passed")

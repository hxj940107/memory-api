import assert from "node:assert/strict"
import {
  SUMMARY_HEADINGS,
  validateFinalSummary,
} from "../scripts/compress-rebuilt-summary.js"

const validSummary = SUMMARY_HEADINGS
  .map((heading) => `${heading}\n- ${"有效内容".repeat(35)}。`)
  .join("\n\n")

const validResult = validateFinalSummary(validSummary)
assert.equal(validResult.valid, true)
assert.equal(validResult.headingsPresent, true)
assert.equal(validResult.sectionsNonEmpty, true)
assert.equal(validResult.completeEnding, true)

assert.equal(
  validateFinalSummary(validSummary.replace("【禁止误归因】", "")).valid,
  false
)
assert.equal(validateFinalSummary(`${validSummary}未完成，`).valid, false)
assert.equal(validateFinalSummary(`${validSummary}${"过长。".repeat(500)}`).valid, false)

console.log("final summary compression tests passed")

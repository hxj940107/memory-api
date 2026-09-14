import assert from "node:assert/strict"
import test from "node:test"

import {
  ANONYMOUS_PRODUCTION_CONTRACT_CORPUS,
  replayXiaoCMemoryQueryPlanContracts,
} from "../scripts/replay-xiaoc-memory-query-plan-contract.js"

test("anonymous 187-opportunity contract replay repairs only the three known failures", () => {
  const result = replayXiaoCMemoryQueryPlanContracts()
  assert.equal(ANONYMOUS_PRODUCTION_CONTRACT_CORPUS.length, 187)
  assert.deepEqual(result, {
    attempted_replay_count: 187,
    changed_plan_count: 3,
    invalid_count: 0,
    skip_count: 1,
    unintended_drift_count: 0,
    former_failures: {
      "former-21-term": { final_term_count: 12, should_retrieve: true },
      "former-14-term": { final_term_count: 12, should_retrieve: true },
      "former-zero-term": { final_term_count: 0, should_retrieve: false },
    },
  })
})

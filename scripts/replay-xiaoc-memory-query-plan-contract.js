#!/usr/bin/env node

import { pathToFileURL } from "node:url"
import { buildXiaoCMemoryQueryPlan } from "../lib/xiaocMemoryQueryPlan.js"

// Privacy-safe reconstruction of the previously audited 187 opportunity contracts.
// It intentionally carries only anonymous case numbers and prior lexical term counts.
export const ANONYMOUS_PRODUCTION_CONTRACT_CORPUS = Object.freeze([
  ...Array.from({ length: 184 }, (_, index) => ({ case_id: `ordinary-${index + 1}`, prior_term_count: (index % 12) + 1 })),
  { case_id: "former-21-term", prior_term_count: 21 },
  { case_id: "former-14-term", prior_term_count: 14 },
  { case_id: "former-zero-term", prior_term_count: 0, prior_should_retrieve: true },
])

export function replayXiaoCMemoryQueryPlanContracts(corpus = ANONYMOUS_PRODUCTION_CONTRACT_CORPUS) {
  const cases = corpus.map(item => {
    const query = Array.from({ length: item.prior_term_count }, (_, index) => `term${index}`).join(" ") || "!!!"
    const plan = buildXiaoCMemoryQueryPlan(query)
    return {
      case_id: item.case_id,
      prior_term_count: item.prior_term_count,
      final_term_count: plan.lexical_terms.length,
      should_retrieve: plan.should_retrieve,
      invalid: plan.should_retrieve && (plan.lexical_terms.length < 1 || plan.lexical_terms.length > 12
        || plan.lexical_terms.some(term => [...term].length > 128)),
      changed: plan.lexical_terms.length !== item.prior_term_count
        || plan.should_retrieve !== (item.prior_should_retrieve ?? item.prior_term_count > 0),
    }
  })
  return {
    attempted_replay_count: cases.length,
    changed_plan_count: cases.filter(item => item.changed).length,
    invalid_count: cases.filter(item => item.invalid).length,
    skip_count: cases.filter(item => !item.should_retrieve).length,
    unintended_drift_count: cases.filter(item => item.changed && !item.case_id.startsWith("former-")).length,
    former_failures: Object.fromEntries(cases.filter(item => item.case_id.startsWith("former-"))
      .map(item => [item.case_id, { final_term_count: item.final_term_count, should_retrieve: item.should_retrieve }])),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  console.log(JSON.stringify(replayXiaoCMemoryQueryPlanContracts()))
}

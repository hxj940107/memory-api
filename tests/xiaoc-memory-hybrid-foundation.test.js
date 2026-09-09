import assert from "node:assert/strict"
import test from "node:test"

import {
  buildHybridCandidate,
  evaluateRetrievalEligibility,
  retrieveOfflineCandidates,
} from "../lib/xiaocMemoryRetrievalFoundation.js"

function legacy(overrides = {}) {
  return {
    id: "legacy-1", user_id: "user", canonical_content: "她曾经去过一座海岛旅行。", content_hash: "a".repeat(64),
    provenance_status: "legacy_unverified", authority_tier: "legacy_limited", retrieval_tier: "low_authority",
    lifecycle_status: "active", claim_key: null, importance: 5, valid_from: null, valid_until: null, resolved_at: null,
    ...overrides,
  }
}

test("low-authority legacy remains eligible only as legacy-limited", () => {
  const result = evaluateRetrievalEligibility(legacy(), { userId: "user" })
  assert.equal(result.eligible, true)
  assert.equal(result.authorityBand, "legacy_limited")
})

test("shadow, disabled, superseded, deleted and cross-user rows are excluded", () => {
  assert.equal(evaluateRetrievalEligibility(legacy({ retrieval_tier: "shadow_only", authority_tier: "none" }), { userId: "user" }).eligible, false)
  assert.equal(evaluateRetrievalEligibility(legacy({ retrieval_tier: "disabled", authority_tier: "none" }), { userId: "user" }).eligible, false)
  assert.equal(evaluateRetrievalEligibility(legacy({ lifecycle_status: "superseded" }), { userId: "user" }).eligible, false)
  assert.equal(evaluateRetrievalEligibility(legacy({ lifecycle_status: "deleted" }), { userId: "user" }).eligible, false)
  assert.equal(evaluateRetrievalEligibility(legacy({ user_id: "other" }), { userId: "user" }).eligible, false)
})

test("hybrid candidate keeps lexical-only and no-semantic degradation structured", () => {
  const result = buildHybridCandidate({ memory: legacy(), userId: "user", query: "海岛旅行" })
  assert.equal(result.eligible, true)
  assert.ok(result.lexical_score > 0)
  assert.equal(result.semantic_available, false)
  assert.equal(result.semantic_score, null)
  assert.deepEqual(result.semantic_reason_codes, ["SEMANTIC_UNAVAILABLE"])
})

test("semantic-only synthetic and both-signal candidates are represented", () => {
  const semanticOnly = buildHybridCandidate({ memory: legacy({ canonical_content: "完全不同的文本" }), userId: "user", query: "无关查询", queryEmbedding: [1, 0], memoryEmbedding: [1, 0] })
  assert.equal(semanticOnly.semantic_score, 1)
  assert.equal(semanticOnly.semantic_available, true)
  const both = buildHybridCandidate({ memory: legacy(), userId: "user", query: "海岛旅行", queryEmbedding: [1, 0], memoryEmbedding: [0.8, 0.2] })
  assert.ok(both.lexical_score > 0)
  assert.ok(both.semantic_score > 0.9)
})

test("offline retrieval never returns ineligible rows and works without embeddings", async () => {
  const repository = { async listCandidates() { return [legacy(), legacy({ id: "shadow", retrieval_tier: "shadow_only", authority_tier: "none" }), legacy({ id: "other", user_id: "other" })] } }
  const result = await retrieveOfflineCandidates({ repository, userId: "user", query: "海岛", limit: 10 })
  assert.deepEqual(result.map((item) => item.memory_id), ["legacy-1"])
  assert.equal(result[0].semantic_available, false)
})

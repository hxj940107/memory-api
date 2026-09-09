import assert from "node:assert/strict"
import test from "node:test"

import { buildXiaoCMemoryQueryPlan } from "../lib/xiaocMemoryQueryPlan.js"
import { retrieveXiaoCMemoriesOffline } from "../lib/xiaocMemoryRanking.js"
import { createSyntheticEvaluationRepository, SYNTHETIC_EMBEDDING_IDENTITY } from "../scripts/xiaoc-memory-engine-eval.js"

test("explicit recall shell is removed without naming a fixture entity in production rules", () => {
  const plan = buildXiaoCMemoryQueryPlan("你还记得国庆去海边吗", { explicitRecall: true, mode: "historical_recall" })
  assert.equal(plan.recall_query, "国庆去海边")
  assert.equal(plan.retrieval_query, "国庆去海边")
  assert.equal(plan.grounding_strength, "STRONG")
  assert.ok(plan.reason_codes.includes("RECALL_SHELL_REMOVED"))
})

test("multiple generic Chinese recall shells extract their payload", () => {
  for (const [query, payload] of [
    ["我之前是不是说过喜欢抹茶吗", "喜欢抹茶"],
    ["以前我提过那部电影吗", "那部电影"],
    ["上次那个约定呢", "约定"],
  ]) assert.equal(buildXiaoCMemoryQueryPlan(query, { explicitRecall: true }).recall_query, payload)
})

test("ambiguous reference without grounding safely skips retrieval", () => {
  for (const query of ["那个呢", "后来呢", "还买吗", "真的？"]) {
    const plan = buildXiaoCMemoryQueryPlan(query)
    assert.equal(plan.should_retrieve, false, query)
    assert.ok(plan.reason_codes.includes("QUERY_INSUFFICIENT_GROUNDING"))
  }
})

test("strong bounded grounding converts a weak reference into an anchor query", () => {
  const plan = buildXiaoCMemoryQueryPlan("还买吗", { grounding: { strength: "STRONG", anchors: [{ value: "降噪耳机", kind: "active_entity" }] } })
  assert.equal(plan.should_retrieve, true)
  assert.equal(plan.retrieval_query, "降噪耳机")
  assert.equal(plan.grounding_anchor_count, 1)
})

test("weak grounding does not authorize an otherwise ambiguous lookup", () => {
  const plan = buildXiaoCMemoryQueryPlan("后来呢", { grounding: { strength: "WEAK", anchors: ["一件事"] } })
  assert.equal(plan.should_retrieve, false)
})

test("grounding remains query metadata and cannot alter authority", () => {
  const plan = buildXiaoCMemoryQueryPlan("后来呢", { grounding: { strength: "STRONG", anchors: ["烘焙课"] } })
  assert.equal(Object.hasOwn(plan, "provenance_status"), false)
  assert.equal(Object.hasOwn(plan, "authority_tier"), false)
  assert.equal(Object.hasOwn(plan, "claim_key"), false)
})

function fixtureCase(overrides = {}) {
  return {
    query: "上次的作品", mode: "historical_recall", memories: [{ id: "candidate", content: "另一件事情" }],
    query_vector: [1, 0], semantic_vectors: { candidate: [1, 0] }, relations: [], external_claims: [], ...overrides,
  }
}

async function runCase(definition, options = {}) {
  return retrieveXiaoCMemoriesOffline({
    repository: createSyntheticEvaluationRepository(definition), userId: "user", query: definition.query,
    queryEmbedding: definition.query_vector, embeddingIdentity: SYNTHETIC_EMBEDDING_IDENTITY,
    retrievalTime: "2026-09-09T12:00:00Z", mode: definition.mode, retrievalContext: options.retrievalContext,
    explicitRecall: options.explicitRecall || false,
  })
}

test("ungrounded semantic-only similarity is rejected before ranking", async () => {
  const result = await runCase(fixtureCase())
  assert.equal(result.results.length, 0)
  assert.equal(result.trace.compatibility_rejections[0].reason_codes[0], "SEMANTIC_ONLY_UNGROUNDED")
})

test("strong grounded semantic-only evidence remains available", async () => {
  const definition = fixtureCase({ memories: [{ id: "candidate", content: "她报名了甜点制作课程" }] })
  const result = await runCase(definition, { retrievalContext: { grounding: { strength: "STRONG", anchors: ["烘焙课"] } } })
  assert.deepEqual(result.results.map((item) => item.memory_id), ["candidate"])
})

test("explicit trusted historical recall can ground a strong semantic-only match", async () => {
  const result = await runCase(fixtureCase(), { explicitRecall: true })
  assert.deepEqual(result.results.map((item) => item.memory_id), ["candidate"])
})

test("strong lexical evidence rejects a competing semantic-only distractor", async () => {
  const definition = fixtureCase({
    query: "小满", memories: [{ id: "exact", content: "她喜欢被叫小满" }, { id: "wrong", content: "无关物品" }],
    semantic_vectors: { exact: [0.7, 0.71414284], wrong: [1, 0] },
  })
  const result = await runCase(definition)
  assert.deepEqual(result.results.map((item) => item.memory_id), ["exact"])
  assert.ok(result.trace.compatibility_rejections.find((item) => item.memory_id === "wrong").reason_codes.includes("SEMANTIC_CONFLICTS_WITH_STRONG_LEXICAL_EVIDENCE"))
})

test("semantic admission never bypasses deterministic eligibility", async () => {
  const definition = fixtureCase({ memories: [{ id: "candidate", content: "另一件事情", kind: "legacy", retrieval_tier: "disabled", authority_tier: "none" }] })
  const result = await runCase(definition, { explicitRecall: true })
  assert.equal(result.results.length, 0)
  assert.equal(result.trace.suppressed_candidates[0].memory_id, "candidate")
})

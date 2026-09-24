import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"

import {
  buildXiaoCMemoryQueryPlan,
  XIAOC_MEMORY_LEXICAL_MAX_TERM_CODEPOINTS,
  XIAOC_MEMORY_LEXICAL_MAX_TERMS,
} from "../lib/xiaocMemoryQueryPlan.js"

test("question-word 什么 is not truncated as a trailing particle", () => {
  const plan = buildXiaoCMemoryQueryPlan("我叫什么？")
  assert.equal(plan.retrieval_query.includes("什么"), true)
  assert.equal(plan.retrieval_query.includes("我叫什") && !plan.retrieval_query.includes("什么"), false)
})

test("production query planning contains no incident-specific name or durian rules", async () => {
  const source = await readFile(new URL("../lib/xiaocMemoryQueryPlan.js", import.meta.url), "utf8")
  assert.equal(source.includes("姓名"), false)
  assert.equal(source.includes("榴莲"), false)
})
import {
  retrieveXiaoCMemoriesOffline,
  XIAOC_MEMORY_RETRIEVAL_POLICY,
} from "../lib/xiaocMemoryRanking.js"
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

test("v2 planner enforces zero, one, twelve, thirteen and larger term bounds", () => {
  assert.equal(buildXiaoCMemoryQueryPlan("").lexical_terms.length, 0)
  assert.equal(buildXiaoCMemoryQueryPlan("!!!").lexical_terms.length, 0)
  assert.equal(buildXiaoCMemoryQueryPlan("alpha").lexical_terms.length, 1)
  for (const size of [12, 13, 21]) {
    const plan = buildXiaoCMemoryQueryPlan(Array.from({ length: size }, (_, index) => `term${index}`).join(" "))
    assert.equal(plan.version, "xiaoc-query-plan-v2")
    assert.equal(plan.lexical_terms.length, Math.min(size, XIAOC_MEMORY_LEXICAL_MAX_TERMS))
    assert.deepEqual(plan.lexical_terms, Array.from({ length: Math.min(size, 12) }, (_, index) => `term${index}`))
  }
})

test("planner removes duplicates, empty/generic tokens and overlong Unicode terms", () => {
  assert.deepEqual(buildXiaoCMemoryQueryPlan("alpha alpha 我 你").lexical_terms, ["alpha"])
  const overlong = "界".repeat(XIAOC_MEMORY_LEXICAL_MAX_TERM_CODEPOINTS + 1)
  const plan = buildXiaoCMemoryQueryPlan(overlong)
  assert.deepEqual(plan.lexical_terms, [])
  assert.equal(plan.should_retrieve, false)
})

test("CJK-only and mixed CJK/ASCII preserve extraction order", () => {
  assert.deepEqual(buildXiaoCMemoryQueryPlan("海岛旅行").lexical_terms, ["海岛旅行"])
  assert.deepEqual(buildXiaoCMemoryQueryPlan("ProjectX 海岛旅行").lexical_terms, ["projectx", "海岛旅行"])
})

test("payload terms outrank grounding anchors and entity terms rebuild from the bounded list", () => {
  const payload = Array.from({ length: 11 }, (_, index) => `payload${index}`).join(" ")
  const plan = buildXiaoCMemoryQueryPlan(payload, { grounding: { strength: "STRONG", anchors: ["anchor1", "anchor2"] } })
  assert.deepEqual(plan.lexical_terms.slice(0, 11), Array.from({ length: 11 }, (_, index) => `payload${index}`))
  assert.equal(plan.lexical_terms[11], "anchor1")
  assert.equal(plan.lexical_terms.includes("anchor2"), false)
  assert.deepEqual(plan.entity_like_terms, plan.lexical_terms)
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

test("eligible semantic-only candidates enter ranking without lexical grounding or recall anchors", async () => {
  const result = await runCase(fixtureCase())
  assert.deepEqual(result.results.map(item => item.memory_id), ["candidate"])
  assert.equal(result.trace.compatibility_rejections.length, 0)
  assert.equal(result.trace.ranking_decisions[0].component_scores.lexical, 0)
  assert.equal(result.trace.ranking_decisions[0].component_scores.semantic, 1)
  assert.equal(result.trace.ranking_decisions[0].rank, 1)
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

test("semantic-only candidates are not vetoed before ranking by a strong lexical competitor", async () => {
  const definition = fixtureCase({
    query: "小满", memories: [{ id: "exact", content: "她喜欢被叫小满" }, { id: "wrong", content: "无关物品" }],
    semantic_vectors: { exact: [0.7, 0.71414284], wrong: [1, 0] },
  })
  const result = await runCase(definition)
  assert.equal(result.trace.compatibility_rejections.length, 0)
  assert.ok(result.trace.ranking_decisions.some(item => item.memory_id === "exact"))
  assert.ok(result.trace.ranking_decisions.some(item => item.memory_id === "wrong"))
})

test("semantic-only relevance below the former 0.58 gate remains in the ranked pool", async () => {
  const definition = fixtureCase({
    memories: [{ id: "high", content: "第一段无字面重合内容" }, { id: "weak", content: "第二段无字面重合内容" }],
    semantic_vectors: { high: [0.7, 0.71414284], weak: [0.5, 0.8660254] },
  })
  const result = await runCase(definition)
  assert.deepEqual(result.results.map(item => item.memory_id), ["high", "weak"])
  assert.equal(result.trace.ranked_count, 2)
  assert.equal(result.trace.compatibility_rejections.length, 0)
  const weak = result.trace.ranking_decisions.find(item => item.memory_id === "weak")
  assert.equal(weak.component_scores.semantic, 0.5)
  assert.ok(weak.reason_codes.includes("RANKED_BY_RELEVANCE"))
})

test("real recall phrasings remain fixtures without production keyword or perspective rules", async () => {
  for (const [definition, options] of [
    [fixtureCase({ query: "我叫什么？", memories: [{ id: "name", content: "她被家人用一个特别称呼叫着" }], semantic_vectors: { name: [0.7, 0.71414284] } }), {}],
    [fixtureCase({ query: "还记得榴莲吗？", memories: [{ id: "pet", content: "她养着一只对她很重要的小狗" }], semantic_vectors: { pet: [0.7, 0.71414284] } }), { retrievalContext: { grounding: { strength: "STRONG", anchors: ["旧事"] } } }],
  ]) {
    const result = await runCase(definition, options)
    assert.equal(result.results.length, 1)
    assert.equal(result.trace.ranking_decisions[0].component_scores.lexical, 0)
    assert.equal(result.trace.ranking_decisions[0].rank, 1)
  }
})

test("semantic admission never bypasses deterministic eligibility", async () => {
  const definition = fixtureCase({ memories: [{ id: "candidate", content: "另一件事情", kind: "legacy", retrieval_tier: "disabled", authority_tier: "none" }] })
  const result = await runCase(definition, { explicitRecall: true })
  assert.equal(result.results.length, 0)
  assert.equal(result.trace.suppressed_candidates[0].memory_id, "candidate")
})

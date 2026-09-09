import assert from "node:assert/strict"
import test from "node:test"

import {
  XIAOC_MEMORY_RETRIEVAL_POLICY,
  generateBoundedCandidates,
  rankEligibleCandidate,
  retrieveXiaoCMemoriesOffline,
  scoreRecency,
} from "../lib/xiaocMemoryRanking.js"

const NOW = "2026-09-09T12:00:00.000Z"
const EMBEDDING_IDENTITY = { providerId: "synthetic", modelId: "fixture", version: "v1", preprocessorVersion: "fixture-v1", dimension: 2 }

function semanticRow(memory, vector) {
  return { memory, vector, rollout_status: "active", provider: "synthetic", model: "fixture", embedding_version: "v1", preprocessor_version: "fixture-v1", dimensions: 2 }
}

function hashFor(id) {
  return Buffer.from(String(id)).toString("hex").padEnd(64, "0").slice(0, 64)
}

function native(id, content, overrides = {}) {
  return {
    id, user_id: "user", canonical_content: content, content_hash: hashFor(id), origin_system: "xiaoc_native",
    memory_class: "observation", provenance_status: "verified_user", authority_tier: "native_verified",
    retrieval_tier: null, lifecycle_status: "active", claim_key: null, importance: 5,
    created_at: "2025-09-09T12:00:00Z", valid_from: null, valid_until: null, resolved_at: null,
    ...overrides,
  }
}

function legacy(id, content, overrides = {}) {
  return native(id, content, { origin_system: "ombre_legacy", provenance_status: "legacy_unverified", authority_tier: "legacy_limited", retrieval_tier: "low_authority", ...overrides })
}

function repository({ lexical = [], semantic = [], relations = [] } = {}) {
  return {
    calls: [],
    async listLexicalCandidates(args) { this.calls.push(["lexical", args]); return lexical.slice(0, args.limit) },
    async listSemanticCandidates(args) { this.calls.push(["semantic", args]); return semantic.slice(0, args.limit) },
    async listRelations(args) { this.calls.push(["relations", args]); return relations },
  }
}

const retrieve = (repo, options = {}) => retrieveXiaoCMemoriesOffline({ repository: repo, userId: "user", query: "长滩岛", retrievalTime: NOW, ...options })

test("lexical-only generation is bounded and marks degradation", async () => {
  const repo = repository({ lexical: [native("island", "她以前去过长滩岛")] })
  const generated = await generateBoundedCandidates({ repository: repo, userId: "user", query: "长滩岛" })
  assert.equal(generated.candidates.length, 1)
  assert.equal(generated.candidates[0].semantic_available, false)
  assert.equal(generated.degradation_mode, "LEXICAL_ONLY")
  assert.equal(repo.calls[0][1].limit, XIAOC_MEMORY_RETRIEVAL_POLICY.lexicalCandidateLimit)
})

test("semantic-only synthetic generation retains a real semantic signal", async () => {
  const repo = repository({ semantic: [semanticRow(native("semantic", "一次旧旅行"), [1, 0])] })
  const generated = await generateBoundedCandidates({ repository: repo, userId: "user", query: "完全不同文字", queryEmbedding: [1, 0], embeddingIdentity: EMBEDDING_IDENTITY })
  assert.equal(generated.candidates[0].lexical_score, 0)
  assert.equal(generated.candidates[0].semantic_score, 1)
  assert.equal(generated.degradation_mode, "HYBRID_AVAILABLE")
})

test("zero compatible Memory embeddings remains explicitly lexical-only", async () => {
  const memory = native("lexical-with-query-vector", "长滩岛")
  const generated = await generateBoundedCandidates({ repository: repository({ lexical: [memory], semantic: [] }), userId: "user", query: "长滩岛", queryEmbedding: [1, 0], embeddingIdentity: EMBEDDING_IDENTITY })
  assert.equal(generated.degradation_mode, "LEXICAL_ONLY")
  assert.equal(generated.candidates[0].semantic_available, false)
  assert.equal(generated.candidates[0].semantic_score, null)
})

test("lexical and semantic channels union duplicate memory ID", async () => {
  const memory = native("both", "Boracay 长滩岛")
  const generated = await generateBoundedCandidates({ repository: repository({ lexical: [memory], semantic: [semanticRow(memory, [1, 0])] }), userId: "user", query: "长滩岛", queryEmbedding: [1, 0], embeddingIdentity: EMBEDDING_IDENTITY })
  assert.equal(generated.candidates.length, 1)
  assert.ok(generated.candidates[0].lexical_score > 0)
  assert.equal(generated.candidates[0].semantic_score, 1)
})

test("semantic pool rejects inactive or incompatible embedding identities", async () => {
  const memory = native("stale", "旧旅行")
  const inactive = semanticRow(memory, [1, 0])
  inactive.rollout_status = "stale"
  await assert.rejects(() => generateBoundedCandidates({ repository: repository({ semantic: [inactive] }), userId: "user", query: "旅行", queryEmbedding: [1, 0], embeddingIdentity: EMBEDDING_IDENTITY }), /SEMANTIC_EMBEDDING_NOT_ACTIVE/)
  const incompatible = semanticRow(memory, [1, 0])
  incompatible.embedding_version = "old"
  await assert.rejects(() => generateBoundedCandidates({ repository: repository({ semantic: [incompatible] }), userId: "user", query: "旅行", queryEmbedding: [1, 0], embeddingIdentity: EMBEDDING_IDENTITY }), /SEMANTIC_EMBEDDING_IDENTITY_MISMATCH/)
})

test("repository cannot return an unbounded pool", async () => {
  const repo = { async listLexicalCandidates() { return Array.from({ length: 25 }, (_, index) => native(`m${index}`, `memory ${index}`)) } }
  await assert.rejects(() => generateBoundedCandidates({ repository: repo, userId: "user", query: "memory" }), /LEXICAL_REPOSITORY_UNBOUNDED_RESULT/)
})

test("strong exact lexical and strong semantic candidates survive thresholds", async () => {
  const exact = await retrieve(repository({ lexical: [native("exact", "长滩岛")] }))
  assert.deepEqual(exact.results.map((item) => item.memory_id), ["exact"])
  const semantic = await retrieve(repository({ lexical: [], semantic: [semanticRow(native("semantic", "旧日海边旅行"), [1, 0])] }), { queryEmbedding: [1, 0], embeddingIdentity: EMBEDDING_IDENTITY, retrievalContext: { grounding: { strength: "STRONG", anchors: ["海边度假"] } } })
  assert.deepEqual(semantic.results.map((item) => item.memory_id), ["semantic"])
})

test("combined hybrid signal ranks above either weaker signal", async () => {
  const both = native("both", "长滩岛的海边")
  const lexical = native("lexical", "长滩岛附近的一段很长很长的其他说明")
  const semantic = native("semantic", "过去的海岛事件")
  const result = await retrieve(repository({ lexical: [both, lexical], semantic: [semanticRow(both, [1, 0]), semanticRow(semantic, [0.75, 0.6614378278])] }), { queryEmbedding: [1, 0], embeddingIdentity: EMBEDDING_IDENTITY })
  assert.equal(result.results[0].memory_id, "both")
})

test("importance is clamped and remains a small soft boost", async () => {
  const low = native("low", "长滩岛", { importance: -100 })
  const high = native("high", "长滩岛", { importance: 100 })
  const result = await retrieve(repository({ lexical: [low, high] }))
  assert.equal(result.results[0].memory_id, "high")
  assert.equal(result.results[0].importance_score, 1)
})

test("recency decays softly and old events retain a floor", () => {
  const recent = scoreRecency(native("recent", "x", { event_time: "2026-09-01" }), NOW)
  const old = scoreRecency(native("old", "x", { event_time: "2010-01-01" }), NOW)
  assert.ok(recent > old)
  assert.ok(old >= 0.2)
  assert.equal(scoreRecency(native("missing", "x", { created_at: null }), NOW), 0.35)
})

test("authority preference is limited and cannot rescue irrelevant verified memory", async () => {
  const result = await retrieve(repository({ lexical: [native("irrelevant", "完全无关"), legacy("relevant", "长滩岛")] }))
  assert.deepEqual(result.results.map((item) => item.memory_id), ["relevant"])
  assert.equal(result.results[0].legacy_limited, true)
})

test("legacy high semantic remains explicitly legacy-limited", async () => {
  const result = await retrieve(repository({ lexical: [], semantic: [semanticRow(legacy("legacy", "旧旅行"), [1, 0])] }), { queryEmbedding: [1, 0], embeddingIdentity: EMBEDDING_IDENTITY, retrievalContext: { grounding: { strength: "STRONG", anchors: ["旧旅行"] } } })
  assert.equal(result.results[0].legacy_limited, true)
  assert.equal(result.results[0].authority_tier, "legacy_limited")
})

test("lexical-only candidates are not penalized by absent semantic score", async () => {
  const result = await retrieve(repository({ lexical: [native("nickname", "小名叫团子")] }), { query: "团子" })
  assert.equal(result.results[0].semantic_score, null)
  assert.equal(result.results[0].semantic_available, false)
  assert.ok(result.results[0].selection_reason_codes.includes("SIGNAL_MODE_LEXICAL_ONLY"))
})

test("explicit recall applies only an explicit deterministic boost", async () => {
  const repo = repository({ lexical: [native("event", "长滩岛")] })
  const normal = await retrieve(repo)
  const recall = await retrieve(repo, { explicitRecall: true })
  assert.ok(recall.results[0].hybrid_score > normal.results[0].hybrid_score)
  assert.ok(recall.results[0].selection_reason_codes.includes("EXPLICIT_RECALL_BOOST"))
})

test("historical recall admits and boosts an expired historical event", async () => {
  const memory = native("old-plan", "国庆去长滩岛", { valid_until: "2025-10-10" })
  const normal = await retrieve(repository({ lexical: [memory] }))
  const historical = await retrieve(repository({ lexical: [memory] }), { mode: "historical_recall", explicitRecall: true })
  assert.equal(normal.results.length, 0)
  assert.equal(historical.results[0].temporal_state, "expired")
  assert.ok(historical.results[0].selection_reason_codes.includes("HISTORICAL_RECALL_BOOST"))
})

test("irrelevant and weak accidental overlap return empty", async () => {
  assert.equal((await retrieve(repository({ lexical: [native("none", "完全无关的工作记录")] }))).results.length, 0)
  assert.equal((await retrieve(repository({ lexical: [native("weak", "长时间工作") ] }), { query: "长滩岛" })).results.length, 0)
})

test("top-k is bounded, configurable and contains no duplicate identities", async () => {
  const rows = [native("a", "长滩岛"), native("b", "长滩岛", { content_hash: hashFor("a") }), native("c", "长滩岛海边"), native("d", "长滩岛旅行")]
  const result = await retrieve(repository({ lexical: rows }), { topK: 2 })
  assert.equal(result.results.length, 2)
  assert.equal(new Set(result.results.map((item) => item.memory_id)).size, 2)
  assert.equal(result.results.filter((item) => ["a", "b"].includes(item.memory_id)).length, 1)
})

test("input permutation preserves deterministic ranking and tie-break", async () => {
  const rows = [native("b", "长滩岛"), native("a", "长滩岛"), native("c", "长滩岛")]
  const first = await retrieve(repository({ lexical: rows }))
  const second = await retrieve(repository({ lexical: [...rows].reverse() }))
  assert.deepEqual(first.results, second.results)
  assert.deepEqual(first.results.map((item) => item.memory_id), ["a", "b", "c"])
})

test("hard-gated candidates never reach ranking regardless of soft scores", async () => {
  const rows = [
    legacy("shadow", "长滩岛", { retrieval_tier: "shadow_only", authority_tier: "none", importance: 10 }),
    legacy("disabled", "长滩岛", { retrieval_tier: "disabled", authority_tier: "none", importance: 10 }),
    native("superseded", "长滩岛", { lifecycle_status: "superseded", importance: 10 }),
    native("cross", "长滩岛", { user_id: "other", importance: 10 }),
    native("safe", "长滩岛附近", { importance: 1 }),
  ]
  const result = await retrieve(repository({ lexical: rows }))
  assert.deepEqual(result.results.map((item) => item.memory_id), ["safe"])
  assert.equal(result.trace.suppressed_count, 4)
})

test("relation-suppressed target cannot be resurrected by perfect relevance", async () => {
  const repo = repository({
    lexical: [legacy("old", "长滩岛", { importance: 10 }), native("new", "长滩岛附近")],
    relations: [{ user_id: "user", from_memory_id: "new", to_memory_id: "old", relation_type: "supersedes" }],
  })
  const result = await retrieve(repo)
  assert.deepEqual(result.results.map((item) => item.memory_id), ["new"])
})

test("structured result retains safety and explainability metadata", async () => {
  const result = await retrieve(repository({ lexical: [legacy("event", "你还记得那个泳衣吗", { event_time: "2024-06-01" })] }), { query: "泳衣" })
  const item = result.results[0]
  for (const key of ["memory_id", "user_id", "provenance_status", "authority_tier", "retrieval_tier", "lifecycle_status", "legacy_limited", "temporal_state", "lexical_score", "semantic_score", "importance_score", "recency_score", "hybrid_score", "selection_reason_codes", "event_time"]) assert.ok(Object.hasOwn(item, key), key)
})

test("privacy-safe trace contains counts but no query or Memory body", async () => {
  const privateQuery = "private-query-marker"
  const privateBody = "private-body-marker"
  const result = await retrieve(repository({ lexical: [native("private", privateBody)] }), { query: privateQuery })
  const traceText = JSON.stringify(result.trace)
  assert.equal(traceText.includes(privateQuery), false)
  assert.equal(traceText.includes(privateBody), false)
  assert.equal(result.trace.raw_candidate_count, 1)
})

test("offline orchestration makes no request and is not imported by production APIs", async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests += 1; throw new Error("unexpected") }
  try {
    await retrieve(repository({ lexical: [native("local", "长滩岛")] }))
    assert.equal(requests, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
  const { readFile } = await import("node:fs/promises")
  const { readdir } = await import("node:fs/promises")
  for (const file of await readdir(new URL("../api/", import.meta.url))) {
    if (!file.endsWith(".js")) continue
    const source = await readFile(new URL(`../api/${file}`, import.meta.url), "utf8")
    assert.equal(source.includes("xiaocMemoryRanking"), false, file)
  }
})

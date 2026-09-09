import assert from "node:assert/strict"
import test from "node:test"
import { readFile, readdir } from "node:fs/promises"

import { XiaoCMemoryDbRetrievalRepository, buildXiaoCMemoryShadowTelemetry } from "../lib/xiaocMemoryDbRepository.js"
import { retrieveXiaoCMemoriesOffline } from "../lib/xiaocMemoryRanking.js"

const IDENTITY = { providerId: "synthetic", modelId: "model-a", version: "v1", preprocessorVersion: "content-v1", dimension: 3 }
const NOW = "2026-09-10T00:00:00.000Z"

function row(overrides = {}) {
  return {
    memory_id: "10000000-0000-0000-0000-000000000001", user_id: "user", canonical_content: "合成海岛记忆",
    content_hash: "a".repeat(64), origin_system: "xiaoc_native", memory_class: "observation", category: "event",
    provenance_status: "verified_user", lifecycle_status: "active", retrieval_tier: null, authority_tier: "native_verified",
    claim_key: null, importance: 5, confidence: 1, event_time: null, valid_from: null, valid_until: null,
    resolved_at: null, created_at: NOW, ...overrides,
  }
}

function clientFor(responses = {}) {
  return {
    calls: [],
    async rpc(name, params) {
      this.calls.push({ name, params })
      return responses[name] || { data: [], error: null }
    },
  }
}

const makeRepository = (client) => new XiaoCMemoryDbRetrievalRepository(client, { retrievalMode: "normal_current", retrievalTime: NOW, embeddingIdentity: IDENTITY })

test("lexical adapter constructs the bounded RPC and maps real schema fields", async () => {
  const client = clientFor({ xiaoc_memory_retrieve_lexical_candidates: { data: [row()], error: null } })
  const result = await makeRepository(client).listLexicalCandidates({ userId: "user", lexicalTerms: ["海岛", "海岛"], limit: 24 })
  assert.equal(result[0].id, row().memory_id)
  assert.deepEqual(client.calls[0], { name: "xiaoc_memory_retrieve_lexical_candidates", params: {
    p_user_id: "user", p_retrieval_mode: "normal_current", p_retrieval_at: NOW, p_lexical_terms: ["海岛"], p_limit: 24,
  } })
})

test("adapter enforces local hard limits before RPC", async () => {
  const client = clientFor()
  await assert.rejects(() => makeRepository(client).listLexicalCandidates({ userId: "user", lexicalTerms: ["x"], limit: 33 }), /LEXICAL_LIMIT_INVALID/)
  await assert.rejects(() => makeRepository(client).listRelations({ userId: "user", memoryIds: Array.from({ length: 33 }, (_, index) => `id-${index}`) }), /CANDIDATE_IDS_INVALID/)
  assert.equal(client.calls.length, 0)
})

test("cross-user or malformed candidate response fails closed", async () => {
  const cross = clientFor({ xiaoc_memory_retrieve_lexical_candidates: { data: [row({ user_id: "other" })], error: null } })
  await assert.rejects(() => makeRepository(cross).listLexicalCandidates({ userId: "user", lexicalTerms: ["海岛"], limit: 24 }), /DB_CANDIDATE_USER_OR_ID_INVALID/)
  const malformed = clientFor({ xiaoc_memory_retrieve_lexical_candidates: { data: [row({ content_hash: "bad" })], error: null } })
  await assert.rejects(() => makeRepository(malformed).listLexicalCandidates({ userId: "user", lexicalTerms: ["海岛"], limit: 24 }), /DB_CANDIDATE_CONTENT_INVALID/)
})

test("semantic adapter sends exact embedding identity and accepts bounded similarity", async () => {
  const semantic = row({ embedding_id: "20000000-0000-0000-0000-000000000001", provider: "synthetic", model: "model-a", embedding_version: "v1", preprocessor_version: "content-v1", dimensions: 3, rollout_status: "active", semantic_similarity: 0.91 })
  const client = clientFor({ xiaoc_memory_retrieve_semantic_candidates: { data: [semantic], error: null } })
  const result = await makeRepository(client).listSemanticCandidates({ userId: "user", queryEmbedding: [1, 0, 0], embeddingIdentity: IDENTITY, limit: 24 })
  assert.equal(result[0].semantic_similarity, 0.91)
  assert.equal(client.calls[0].params.p_embedding_version, "v1")
  assert.equal(client.calls[0].params.p_dimensions, 3)
})

test("semantic identity mismatch and invalid similarity fail closed", async () => {
  const invalid = row({ provider: "other", model: "model-a", embedding_version: "v1", preprocessor_version: "content-v1", dimensions: 3, rollout_status: "active", semantic_similarity: 2 })
  const client = clientFor({ xiaoc_memory_retrieve_semantic_candidates: { data: [invalid], error: null } })
  await assert.rejects(() => makeRepository(client).listSemanticCandidates({ userId: "user", queryEmbedding: [1, 0, 0], embeddingIdentity: IDENTITY, limit: 24 }), /SEMANTIC_RPC_IDENTITY_OR_SCORE_INVALID/)
})

test("zero semantic candidates is a valid lexical degradation", async () => {
  const client = clientFor({
    xiaoc_memory_retrieve_lexical_candidates: { data: [row()], error: null },
    xiaoc_memory_retrieve_semantic_candidates: { data: [], error: null },
    xiaoc_memory_retrieve_candidate_relations: { data: [], error: null },
  })
  const result = await retrieveXiaoCMemoriesOffline({ repository: makeRepository(client), userId: "user", query: "海岛", queryEmbedding: [1, 0, 0], embeddingIdentity: IDENTITY, retrievalTime: NOW })
  assert.equal(result.trace.degradation_mode, "LEXICAL_ONLY")
  assert.equal(result.results[0].semantic_available, false)
})

test("relation adapter retains replacement outside candidate pool", async () => {
  const relation = { relation_id: "30000000-0000-0000-0000-000000000001", user_id: "user", from_memory_id: "replacement", to_memory_id: "candidate", relation_type: "supersedes", created_at: NOW }
  const client = clientFor({ xiaoc_memory_retrieve_candidate_relations: { data: [relation], error: null } })
  const result = await makeRepository(client).listRelations({ userId: "user", memoryIds: ["candidate"] })
  assert.equal(result[0].from_memory_id, "replacement")
  assert.equal(result[0].to_memory_id, "candidate")
})

test("all Supabase errors fail closed without returning partial data", async () => {
  const client = clientFor({ xiaoc_memory_retrieve_lexical_candidates: { data: [row()], error: { code: "42501" } } })
  await assert.rejects(() => makeRepository(client).listLexicalCandidates({ userId: "user", lexicalTerms: ["海岛"], limit: 24 }), /LEXICAL_RPC_FAILED:42501/)
})

test("privacy-safe telemetry excludes query, body, vectors, and candidate IDs", () => {
  const telemetry = buildXiaoCMemoryShadowTelemetry({ trace: {
    query_plan: { should_retrieve: true }, channel_candidate_counts: { lexical: 2, semantic: 0 },
    eligible_count: 1, suppressed_count: 1, selected_count: 1, degradation_mode: "LEXICAL_ONLY",
    reason_code_counts: { RETRIEVAL_TIER_DISABLED: 1 }, latency_ms: { total: 12 },
  } })
  assert.deepEqual(Object.keys(telemetry), ["attempted", "lexical_candidate_count", "semantic_candidate_count", "eligible_count", "suppressed_count", "selected_count", "degradation_mode", "reason_code_counts", "latency_ms"])
  assert.equal(JSON.stringify(telemetry).includes("合成海岛记忆"), false)
})

test("migration implements eligible-before-vector and protected bounded RPCs", async () => {
  const sql = await readFile(new URL("../supabase_xiaoc_memory_engine_m3d0_retrieval.sql", import.meta.url), "utf8")
  assert.ok(sql.includes("xiaoc_memory_retrieval_row_eligible(mi, p_retrieval_mode, p_retrieval_at)"))
  assert.ok(sql.indexOf("xiaoc_memory_retrieval_row_eligible(mi") < sql.indexOf("order by e.embedding <=> p_query_embedding"))
  assert.ok(sql.includes("e.rollout_status = 'active'"))
  for (const field of ["e.provider = p_provider", "e.model = p_model", "e.embedding_version = p_embedding_version", "e.preprocessor_version = p_preprocessor_version", "e.dimensions = p_dimensions"]) assert.ok(sql.includes(field), field)
  assert.ok(sql.includes("p_limit > 32"))
  assert.ok(sql.includes("p_limit > 128"))
  assert.ok(sql.includes("security definer"))
  assert.ok(sql.includes("set search_path = public, extensions, pg_catalog"))
  assert.ok(sql.includes("grant execute on function public.xiaoc_memory_retrieve_semantic_candidates"))
  assert.equal(/grant\s+(insert|update|delete)/i.test(sql), false)
})

test("validation SQL is transactional, synthetic, role-aware, and covers zero embeddings", async () => {
  const sql = await readFile(new URL("../supabase_xiaoc_memory_engine_m3d0_retrieval_validation.sql", import.meta.url), "utf8")
  assert.ok(/^--[\s\S]*\nbegin;/i.test(sql))
  assert.ok(/rollback;\s*$/i.test(sql))
  assert.ok(sql.includes("set local role service_role"))
  assert.ok(sql.includes("replacement outside pool relation missing"))
  assert.ok(sql.includes("incompatible/zero embedding should return zero"))
  assert.equal(sql.includes("8f80b744-2db8-4f78-85a3-78a2cfec679d"), false)
})

test("DB adapter remains disconnected from production Chat and Context Gateway", async () => {
  for (const file of await readdir(new URL("../api/", import.meta.url))) {
    if (!file.endsWith(".js")) continue
    const source = await readFile(new URL(`../api/${file}`, import.meta.url), "utf8")
    assert.equal(source.includes("xiaocMemoryDbRepository"), false, file)
  }
})

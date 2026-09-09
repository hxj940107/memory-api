import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  cosineSimilarity,
  createOpenAICompatibleEmbeddingProvider,
  embeddingStaleness,
  validateEmbeddingVector,
  XiaoCMemoryEmbeddingRepository,
} from "../lib/xiaocMemoryEmbedding.js"
import {
  assertEmbeddingApplyAuthorization,
  dryRunSummary,
  parseEmbeddingArgs,
} from "../scripts/xiaoc-memory-engine-embed.js"

const identity = { providerId: "fixture-provider", modelId: "fixture-model", version: "v1", preprocessorVersion: "canonical-content-v1", dimension: 3 }

test("provider identity, model, version, dimension and batch capability are tracked", () => {
  const provider = createOpenAICompatibleEmbeddingProvider({ ...identity, apiKey: "fixture", baseUrl: "https://example.invalid", fetchImpl: () => { throw new Error("must not call") } })
  assert.equal(provider.providerId, "fixture-provider")
  assert.equal(provider.modelId, "fixture-model")
  assert.equal(provider.version, "v1")
  assert.equal(provider.dimension, 3)
  assert.equal(provider.supportsBatch, true)
})

test("dimension and non-finite values fail closed", () => {
  assert.throws(() => validateEmbeddingVector([1, 2], 3), /EMBEDDING_DIMENSION_MISMATCH/)
  assert.throws(() => validateEmbeddingVector([1, Number.NaN, 3], 3), /EMBEDDING_NON_FINITE_VALUE/)
  assert.throws(() => validateEmbeddingVector([1, Infinity, 3], 3), /EMBEDDING_NON_FINITE_VALUE/)
})

test("cosine similarity is deterministic and validates dimensions", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1)
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0)
  assert.throws(() => cosineSimilarity([1], [1, 2]), /SEMANTIC_VECTOR_DIMENSION_MISMATCH/)
})

test("staleness explains content and every embedding identity change", () => {
  const stored = { content_hash: "a", provider: "fixture-provider", model: "fixture-model", embedding_version: "v1", preprocessor_version: "canonical-content-v1", dimensions: 3, rollout_status: "active" }
  assert.equal(embeddingStaleness(stored, { ...identity, contentHash: "a" }).stale, false)
  const result = embeddingStaleness({ ...stored, content_hash: "old", provider: "old", model: "old", embedding_version: "old", dimensions: 2 }, { ...identity, contentHash: "new" })
  assert.deepEqual(result.reasonCodes, ["CONTENT_HASH_CHANGED", "PROVIDER_CHANGED", "MODEL_CHANGED", "MODEL_VERSION_CHANGED", "DIMENSION_CHANGED"])
})

test("repository uses protected register and activate RPC lifecycle only", async () => {
  const calls = []
  const repository = new XiaoCMemoryEmbeddingRepository({ async rpc(name, params) { calls.push({ name, params }); return { data: `${name}-id`, error: null } } })
  await repository.registerShadow({ userId: "user", memoryId: "memory-1", contentHash: "a".repeat(64), vector: [1, 0, 0], identity, policyVersion: "p1", idempotencyKey: "register-1" })
  await repository.activateShadow({ userId: "user", embeddingId: "embedding-1", policyVersion: "p1", idempotencyKey: "activate-1" })
  assert.deepEqual(calls.map((call) => call.name), ["xiaoc_memory_register_embedding", "xiaoc_memory_activate_embedding"])
  assert.equal(calls[0].params.p_embedding_version, "v1")
})

test("deployed activation contract retires the prior active row before activating shadow", () => {
  const sql = readFileSync(new URL("../supabase_xiaoc_memory_engine_foundation.sql", import.meta.url), "utf8")
  const retire = sql.indexOf("update public.memory_embeddings set rollout_status = 'retired'")
  const activate = sql.indexOf("update public.memory_embeddings set rollout_status = 'active'", retire)
  assert.ok(retire >= 0 && activate > retire)
  assert.match(sql, /memory_embeddings_one_active_idx[\s\S]*where rollout_status = 'active'/)
})

test("embedding CLI defaults to dry-run and cannot make an unscoped write", () => {
  assert.deepEqual(dryRunSummary(parseEmbeddingArgs([])).external_requests, 0)
  assert.throws(() => assertEmbeddingApplyAuthorization(parseEmbeddingArgs(["--apply"])), /EMBEDDING_IDENTITY_REQUIRED/)
  const approved = parseEmbeddingArgs(["--apply", "--provider=p", "--model=m", "--version=v1", "--dimension=3", "--scope=low_authority", "--confirm-count=6"])
  assert.doesNotThrow(() => assertEmbeddingApplyAuthorization(approved))
  assert.throws(() => assertEmbeddingApplyAuthorization({ ...approved, scope: "all" }), /EMBEDDING_SCOPE_NOT_ALLOWED/)
})

test("module construction and dry-run make no external request", () => {
  let calls = 0
  createOpenAICompatibleEmbeddingProvider({ ...identity, apiKey: "fixture", baseUrl: "https://example.invalid", fetchImpl: async () => { calls += 1 } })
  dryRunSummary(parseEmbeddingArgs(["--dry-run"]))
  assert.equal(calls, 0)
})

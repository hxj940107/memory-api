import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  backfillMemoryEmbeddingsBatch,
  cosineSimilarity,
  createOpenAICompatibleEmbeddingProvider,
  embeddingStaleness,
  hashEmbeddingInput,
  inventoryMemoryEmbeddings,
  reconcileMissingNativeEmbeddings,
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
  assert.throws(() => assertEmbeddingApplyAuthorization(parseEmbeddingArgs(["--apply"])), /EMBEDDING_SCOPE_NOT_ALLOWED/)
  const approved = parseEmbeddingArgs(["--apply", "--scope=low_authority", "--confirm-count=72"])
  assert.doesNotThrow(() => assertEmbeddingApplyAuthorization(approved))
  assert.throws(() => assertEmbeddingApplyAuthorization({ ...approved, scope: "all" }), /EMBEDDING_SCOPE_NOT_ALLOWED/)
  assert.throws(() => assertEmbeddingApplyAuthorization({ ...approved, model: "other" }), /EMBEDDING_IDENTITY_MISMATCH/)
})

test("module construction and dry-run make no external request", () => {
  let calls = 0
  createOpenAICompatibleEmbeddingProvider({ ...identity, apiKey: "fixture", baseUrl: "https://example.invalid", fetchImpl: async () => { calls += 1 } })
  dryRunSummary(parseEmbeddingArgs(["--dry-run"]))
  assert.equal(calls, 0)
})

test("bounded reconciliation repairs an eligible native memory missing an embedding", async () => {
  const content = "她喜欢安静的雨天"
  let active = null
  const memory = { id: "10000000-0000-4000-8000-000000000001", user_id: "user", canonical_content: content, content_hash: hashEmbeddingInput(content) }
  const chain = value => ({ select(){return this},eq(){return this},is(){return this},order(){return this},limit(){return Promise.resolve({data:value,error:null})},maybeSingle(){return Promise.resolve({data:active,error:null})} })
  const client = {
    from(table) { return chain(table === "memory_items" ? [memory] : []) },
    async rpc(name) {
      if (name === "xiaoc_memory_register_embedding") return { data: "20000000-0000-4000-8000-000000000002", error: null }
      if (name === "xiaoc_memory_activate_embedding") { active = { content_hash: memory.content_hash, provider: "fixture-provider", model: "fixture-model", embedding_version: "v1", preprocessor_version: "canonical-content-v1", dimensions: 3, rollout_status: "active" }; return { data: "op", error: null } }
      return { data: null, error: null }
    },
  }
  const result = await reconcileMissingNativeEmbeddings({ client, provider: { ...identity, embed: async () => [[1,0,0]] }, limit: 1, logger: { log(){}, warn(){} } })
  assert.equal(result.repaired, 1)
})

function maintenanceClient({ memories, embeddings = [] }) {
  const calls = []
  const match = (row, filters) => filters.every(([kind, column, value]) => {
    if (kind === "eq") return row[column] === value
    if (kind === "in") return value.includes(row[column])
    if (kind === "is") return row[column] === value
    return true
  })
  return {
    calls,
    from(table) {
      const rows = table === "memory_items" ? memories : embeddings
      const filters = []
      let rowLimit = null
      const result = () => ({
        data: rows.filter(row => match(row, filters)).slice(0, rowLimit ?? rows.length),
        error: null,
      })
      const query = {
        select() { return query },
        eq(column, value) { filters.push(["eq", column, value]); return query },
        in(column, value) { filters.push(["in", column, value]); return query },
        is(column, value) { filters.push(["is", column, value]); return query },
        order() { return query },
        limit(value) { rowLimit = value; return query },
        maybeSingle() { return Promise.resolve({ data: rows.find(row => match(row, filters)) || null, error: null }) },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject) },
      }
      return query
    },
    async rpc(name, params) {
      calls.push({ name, params })
      if (name === "xiaoc_memory_register_embedding") {
        const id = `embedding-${embeddings.length + 1}`
        embeddings.push({
          id, user_id: params.p_user_id, memory_id: params.p_memory_id,
          provider: params.p_provider, model: params.p_model,
          embedding_version: params.p_embedding_version, preprocessor_version: params.p_preprocessor_version,
          dimensions: identity.dimension, content_hash: params.p_content_hash, rollout_status: "shadow",
        })
        return { data: id, error: null }
      }
      if (name === "xiaoc_memory_activate_embedding") {
        const row = embeddings.find(item => item.id === params.p_embedding_id)
        if (row) row.rollout_status = "active"
        return { data: "operation", error: null }
      }
      return { data: null, error: null }
    },
  }
}

test("maintenance inventory returns only scoped counts and compatible active counts", async () => {
  const nativeContent = "她喜欢雨天"
  const legacyContent = "我们一起看过海"
  const memories = [
    { id: "native-1", user_id: "user", canonical_content: nativeContent, content_hash: hashEmbeddingInput(nativeContent), origin_system: "xiaoc_native", provenance_status: "verified_user", lifecycle_status: "active", retrieval_tier: null, authority_tier: "native_verified" },
    { id: "legacy-1", user_id: "user", canonical_content: legacyContent, content_hash: hashEmbeddingInput(legacyContent), origin_system: "ombre_legacy", provenance_status: "legacy_unverified", lifecycle_status: "active", retrieval_tier: "low_authority", authority_tier: "legacy_limited" },
    { id: "shadow-1", user_id: "user", canonical_content: "不可用", content_hash: "x", origin_system: "ombre_legacy", provenance_status: "legacy_unverified", lifecycle_status: "active", retrieval_tier: "shadow_only", authority_tier: "none" },
  ]
  const embeddings = [{ memory_id: "legacy-1", user_id: "user", provider: identity.providerId, model: identity.modelId, embedding_version: identity.version, preprocessor_version: identity.preprocessorVersion, dimensions: identity.dimension, content_hash: hashEmbeddingInput(legacyContent), rollout_status: "active" }]
  const result = await inventoryMemoryEmbeddings({ client: maintenanceClient({ memories, embeddings }), provider: identity })
  assert.deepEqual(result.scopes.low_authority, { eligible_count: 1, compatible_active_embedding_count: 1 })
  assert.deepEqual(result.scopes.native_verified, { eligible_count: 1, compatible_active_embedding_count: 0 })
  assert.doesNotMatch(JSON.stringify(result), /她喜欢|一起看过|embedding":\[/)
})

test("maintenance backfill is count-confirmed, bounded, idempotent and verifies shadow then active", async () => {
  const content = "她喜欢安静的雨天"
  const memories = [{ id: "native-1", user_id: "user", canonical_content: content, content_hash: hashEmbeddingInput(content), origin_system: "xiaoc_native", provenance_status: "verified_user", lifecycle_status: "active", retrieval_tier: null, authority_tier: "native_verified" }]
  const embeddings = []
  const client = maintenanceClient({ memories, embeddings })
  await assert.rejects(backfillMemoryEmbeddingsBatch({ client, provider: { ...identity, maxBatchSize: 2, embed: async () => [[1, 0, 0]] }, scope: "native_verified", confirmCount: 2 }), { code: "EMBEDDING_SCOPE_COUNT_MISMATCH" })
  assert.equal(client.calls.length, 0)
  const first = await backfillMemoryEmbeddingsBatch({ client, provider: { ...identity, maxBatchSize: 2, embed: async () => [[1, 0, 0]] }, scope: "native_verified", confirmCount: 1, limit: 1 })
  assert.deepEqual({ processed: first.processed, shadow: first.shadow, active: first.active, failed: first.failed, remaining: first.remaining }, { processed: 1, shadow: 1, active: 1, failed: 0, remaining: 0 })
  assert.deepEqual(client.calls.map(call => call.name), ["xiaoc_memory_register_embedding", "xiaoc_memory_activate_embedding"])
  const retry = await backfillMemoryEmbeddingsBatch({ client, provider: { ...identity, maxBatchSize: 2, embed: async () => assert.fail("already active must not regenerate") }, scope: "native_verified", confirmCount: 1, limit: 1 })
  assert.equal(retry.processed, 0)
  assert.equal(retry.active, 0)
  assert.equal(retry.remaining, 0)
})

test("Memory API maintenance action uses isolated secret auth and fixed server owner", () => {
  const source = readFileSync(new URL("../api/memory.js", import.meta.url), "utf8")
  assert.ok(source.indexOf('requestType === "memory_embedding_maintenance"') < source.indexOf("requireRequestIdentity(req, res)"))
  assert.match(source, /requireXiaoCMaintenanceSecret\(req, process\.env\)/)
  assert.match(source, /configuredPrivateAuthUserUuid\(process\.env\)/)
  assert.match(source, /userId: APP_USER\.defaultUserId/)
  assert.doesNotMatch(source, /memory_embedding_maintenance[\s\S]{0,800}req\.identity/)
  assert.match(source, /XIAOC_MEMORY_EMBEDDING_MAINTENANCE_SCOPES\.includes\(scope\)/)
  assert.match(source, /\.\.\.result\.scopes\[scope\]/)
  assert.match(source, /inventoryMemoryEmbeddings/)
  assert.match(source, /backfillMemoryEmbeddingsBatch/)
})

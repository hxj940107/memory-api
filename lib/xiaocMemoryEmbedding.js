import crypto from "node:crypto"
import { AI_ENDPOINTS, XIAOC_MEMORY_EMBEDDING_IDENTITY } from "./aiConfig.js"

export function validateEmbeddingIdentity(identity = {}) {
  const normalized = {
    providerId: String(identity.providerId || "").trim(),
    modelId: String(identity.modelId || "").trim(),
    version: String(identity.version || "").trim(),
    preprocessorVersion: String(identity.preprocessorVersion || "").trim(),
    dimension: Number(identity.dimension),
  }
  if (!normalized.providerId) throw new Error("EMBEDDING_PROVIDER_REQUIRED")
  if (!normalized.modelId) throw new Error("EMBEDDING_MODEL_REQUIRED")
  if (!normalized.version) throw new Error("EMBEDDING_VERSION_REQUIRED")
  if (!normalized.preprocessorVersion) throw new Error("EMBEDDING_PREPROCESSOR_REQUIRED")
  if (!Number.isInteger(normalized.dimension) || normalized.dimension <= 0) {
    throw new Error("EMBEDDING_DIMENSION_INVALID")
  }
  return normalized
}

export function validateEmbeddingVector(vector, expectedDimension) {
  if (!Array.isArray(vector)) throw new Error("EMBEDDING_VECTOR_REQUIRED")
  if (vector.length !== Number(expectedDimension)) throw new Error("EMBEDDING_DIMENSION_MISMATCH")
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("EMBEDDING_NON_FINITE_VALUE")
  }
  return vector
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) {
    throw new Error("SEMANTIC_VECTOR_DIMENSION_MISMATCH")
  }
  validateEmbeddingVector(left, left.length)
  validateEmbeddingVector(right, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] ** 2
    rightNorm += right[index] ** 2
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

export function embeddingStaleness(embedding, expected = {}) {
  if (!embedding) return { stale: true, reasonCodes: ["EMBEDDING_MISSING"] }
  const identity = validateEmbeddingIdentity(expected)
  const reasons = []
  if (String(embedding.content_hash || "") !== String(expected.contentHash || "")) reasons.push("CONTENT_HASH_CHANGED")
  if (String(embedding.provider || "") !== identity.providerId) reasons.push("PROVIDER_CHANGED")
  if (String(embedding.model || "") !== identity.modelId) reasons.push("MODEL_CHANGED")
  if (String(embedding.embedding_version || "") !== identity.version) reasons.push("MODEL_VERSION_CHANGED")
  if (String(embedding.preprocessor_version || "") !== identity.preprocessorVersion) reasons.push("PREPROCESSOR_CHANGED")
  if (Number(embedding.dimensions) !== identity.dimension) reasons.push("DIMENSION_CHANGED")
  if (!["active", "shadow"].includes(String(embedding.rollout_status || ""))) reasons.push("ROLLOUT_NOT_READABLE")
  return { stale: reasons.length > 0, reasonCodes: reasons }
}

export function hashEmbeddingInput(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex")
}

export function createOpenAICompatibleEmbeddingProvider({
  providerId,
  modelId,
  version,
  preprocessorVersion = "canonical-content-v1",
  dimension,
  apiKey,
  baseUrl,
  fetchImpl = globalThis.fetch,
  maxBatchSize = 32,
  timeoutMs = 1800,
} = {}) {
  const identity = validateEmbeddingIdentity({ providerId, modelId, version, preprocessorVersion, dimension })
  if (!Number.isInteger(maxBatchSize) || maxBatchSize <= 0) throw new Error("EMBEDDING_BATCH_SIZE_INVALID")
  return Object.freeze({
    ...identity,
    maxBatchSize,
    supportsBatch: true,
    async embed(texts) {
      const input = Array.isArray(texts) ? texts : [texts]
      if (!apiKey) throw new Error("EMBEDDING_PROVIDER_CREDENTIAL_MISSING")
      if (!baseUrl) throw new Error("EMBEDDING_PROVIDER_BASE_URL_MISSING")
      if (input.length === 0 || input.length > maxBatchSize || input.some((text) => !String(text || "").trim())) {
        throw new Error("EMBEDDING_INPUT_INVALID")
      }
      const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: identity.modelId, input, dimensions: identity.dimension }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !Array.isArray(payload?.data)) throw new Error("EMBEDDING_PROVIDER_REQUEST_FAILED")
      const vectors = [...payload.data]
        .sort((a, b) => Number(a.index) - Number(b.index))
        .map((item) => validateEmbeddingVector(item.embedding, identity.dimension))
      if (vectors.length !== input.length) throw new Error("EMBEDDING_PROVIDER_RESULT_COUNT_MISMATCH")
      return vectors
    },
  })
}

export function createXiaoCMemoryEmbeddingProvider({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return createOpenAICompatibleEmbeddingProvider({
    ...XIAOC_MEMORY_EMBEDDING_IDENTITY,
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: AI_ENDPOINTS.openRouterEmbeddings,
    fetchImpl,
  })
}

export class XiaoCMemoryEmbeddingRepository {
  constructor(client) {
    if (!client) throw new Error("SUPABASE_CLIENT_REQUIRED")
    this.client = client
  }

  async readActive({ userId, memoryId }) {
    const { data, error } = await this.client.from("memory_embeddings")
      .select("id,user_id,memory_id,provider,model,embedding_version,preprocessor_version,dimensions,content_hash,embedding,rollout_status,created_at")
      .eq("user_id", userId).eq("memory_id", memoryId).eq("rollout_status", "active").maybeSingle()
    if (error) throw error
    return data || null
  }

  async registerShadow({ userId, memoryId, contentHash, vector, identity, policyVersion, idempotencyKey }) {
    const normalized = validateEmbeddingIdentity(identity)
    validateEmbeddingVector(vector, normalized.dimension)
    const { data, error } = await this.client.rpc("xiaoc_memory_register_embedding", {
      p_user_id: userId,
      p_memory_id: memoryId,
      p_provider: normalized.providerId,
      p_model: normalized.modelId,
      p_embedding_version: normalized.version,
      p_preprocessor_version: normalized.preprocessorVersion,
      p_content_hash: contentHash,
      p_embedding: vector,
      p_policy_version: policyVersion,
      p_idempotency_key: idempotencyKey,
    })
    if (error) throw error
    return data
  }

  async activateShadow({ userId, embeddingId, policyVersion, idempotencyKey }) {
    const { data, error } = await this.client.rpc("xiaoc_memory_activate_embedding", {
      p_user_id: userId,
      p_embedding_id: embeddingId,
      p_policy_version: policyVersion,
      p_idempotency_key: idempotencyKey,
    })
    if (error) throw error
    return data
  }
}

export async function ensureActiveMemoryEmbedding({ client, memory, provider, logger = console } = {}) {
  if (!memory?.id || !memory?.user_id || !String(memory?.canonical_content || "").trim()) throw new Error("MEMORY_EMBEDDING_INPUT_INVALID")
  if (hashEmbeddingInput(memory.canonical_content) !== memory.content_hash) throw new Error("MEMORY_CONTENT_HASH_MISMATCH")
  const repository = new XiaoCMemoryEmbeddingRepository(client)
  const active = await repository.readActive({ userId: memory.user_id, memoryId: memory.id })
  if (active && !embeddingStaleness(active, { ...provider, contentHash: memory.content_hash }).stale) {
    return { memory_id: memory.id, status: "already_active" }
  }
  const [vector] = await provider.embed([memory.canonical_content])
  const embeddingId = await repository.registerShadow({
    userId: memory.user_id, memoryId: memory.id, contentHash: memory.content_hash, vector,
    identity: provider, policyVersion: "xiaoc-memory-embedding-foundation-v1",
    idempotencyKey: `${provider.providerId}:${provider.modelId}:${provider.version}:${memory.id}:${memory.content_hash}`,
  })
  await repository.activateShadow({
    userId: memory.user_id, embeddingId, policyVersion: "xiaoc-memory-embedding-foundation-v1",
    idempotencyKey: `activate:${provider.providerId}:${provider.modelId}:${provider.version}:${memory.id}:${memory.content_hash}`,
  })
  logger.log?.("XIAOC MEMORY EMBEDDING READY:", { memory_id: memory.id, status: "activated" })
  return { memory_id: memory.id, status: "activated" }
}

export async function reconcileMissingNativeEmbeddings({ client, provider, userId = "user", limit = 3, logger = console } = {}) {
  const bounded = Math.max(1, Math.min(10, Number(limit) || 3))
  const { data, error } = await client.from("memory_items")
    .select("id,user_id,canonical_content,content_hash")
    .eq("user_id", userId).eq("origin_system", "xiaoc_native")
    .eq("provenance_status", "verified_user").eq("lifecycle_status", "active")
    .is("retrieval_tier", null).eq("authority_tier", "native_verified")
    .order("created_at", { ascending: false }).limit(bounded * 3)
  if (error) throw error
  const repository = new XiaoCMemoryEmbeddingRepository(client)
  let repaired = 0
  for (const memory of data || []) {
    const active = await repository.readActive({ userId, memoryId: memory.id })
    if (active && !embeddingStaleness(active, { ...provider, contentHash: memory.content_hash }).stale) continue
    try { await ensureActiveMemoryEmbedding({ client, memory, provider, logger }); repaired += 1 } catch (error) {
      logger.warn?.("XIAOC MEMORY EMBEDDING RECONCILE FAILED:", { memory_id: memory.id, error_code: String(error?.code || error?.message || "EMBEDDING_FAILED").slice(0, 80) })
    }
    if (repaired >= bounded) break
  }
  return { scanned: (data || []).length, repaired }
}

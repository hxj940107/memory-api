import { createClient } from "@supabase/supabase-js"
import { pathToFileURL } from "node:url"

import {
  createXiaoCMemoryEmbeddingProvider,
  embeddingStaleness,
  hashEmbeddingInput,
  XiaoCMemoryEmbeddingRepository,
} from "../lib/xiaocMemoryEmbedding.js"
import { XIAOC_MEMORY_EMBEDDING_IDENTITY } from "../lib/aiConfig.js"

export const EMBEDDING_POLICY_VERSION = "xiaoc-memory-embedding-foundation-v1"
export const ALLOWED_SCOPES = new Set(["low_authority", "native_verified"])

export function parseEmbeddingArgs(argv) {
  const options = { mode: "dry-run", provider: XIAOC_MEMORY_EMBEDDING_IDENTITY.providerId, model: XIAOC_MEMORY_EMBEDDING_IDENTITY.modelId, version: XIAOC_MEMORY_EMBEDDING_IDENTITY.version, dimension: XIAOC_MEMORY_EMBEDDING_IDENTITY.dimension, scope: "", baseUrl: "", confirmCount: null }
  let explicitMode = false
  for (const arg of argv || []) {
    if (arg === "--dry-run" || arg === "--inventory" || arg === "--apply") {
      const next = arg.slice(2)
      if (explicitMode && options.mode !== next) throw new Error("CONFLICTING_MODES")
      options.mode = next
      explicitMode = true
    } else if (arg.startsWith("--provider=")) options.provider = arg.slice(11).trim()
    else if (arg.startsWith("--model=")) options.model = arg.slice(8).trim()
    else if (arg.startsWith("--version=")) options.version = arg.slice(10).trim()
    else if (arg.startsWith("--dimension=")) options.dimension = Number(arg.slice(12))
    else if (arg.startsWith("--scope=")) options.scope = arg.slice(8).trim()
    else if (arg.startsWith("--base-url=")) options.baseUrl = arg.slice(11).trim()
    else if (arg.startsWith("--confirm-count=")) options.confirmCount = Number(arg.slice(16))
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`)
  }
  return options
}

export function assertEmbeddingApplyAuthorization(options) {
  if (options.mode !== "apply") return
  if (!options.provider || !options.model || !options.version) throw new Error("EMBEDDING_IDENTITY_REQUIRED")
  if (!Number.isInteger(options.dimension) || options.dimension <= 0) throw new Error("EMBEDDING_DIMENSION_INVALID")
  if (!ALLOWED_SCOPES.has(options.scope)) throw new Error("EMBEDDING_SCOPE_NOT_ALLOWED")
  if (!Number.isInteger(options.confirmCount) || options.confirmCount <= 0) throw new Error("EMBEDDING_CONFIRM_COUNT_REQUIRED")
  if (options.provider !== XIAOC_MEMORY_EMBEDDING_IDENTITY.providerId || options.model !== XIAOC_MEMORY_EMBEDDING_IDENTITY.modelId
    || options.version !== XIAOC_MEMORY_EMBEDDING_IDENTITY.version || options.dimension !== XIAOC_MEMORY_EMBEDDING_IDENTITY.dimension) {
    throw new Error("EMBEDDING_IDENTITY_MISMATCH")
  }
}

export function dryRunSummary(options) {
  return {
    mode: "dry-run",
    external_requests: 0,
    supabase_writes: 0,
    provider: options.provider || null,
    model: options.model || null,
    version: options.version || null,
    dimension: Number.isInteger(options.dimension) ? options.dimension : null,
    scope: options.scope || null,
    note: "No Memory was read or transmitted. --apply requires complete identity, allowed scope, credentials, and exact confirmed count.",
  }
}

async function loadScopedMemories(client, scope) {
  let query = client.from("memory_items")
    .select("id,user_id,canonical_content,content_hash,provenance_status,authority_tier,retrieval_tier,lifecycle_status")
    .eq("user_id", "user").eq("lifecycle_status", "active")
  query = scope === "low_authority"
    ? query.eq("provenance_status", "legacy_unverified").eq("retrieval_tier", "low_authority").eq("authority_tier", "legacy_limited")
    : query.eq("origin_system", "xiaoc_native").in("provenance_status", ["verified_user", "manual_confirmed", "derived_verified"]).is("retrieval_tier", null).eq("authority_tier", "native_verified")
  const { data, error } = await query.order("id", { ascending: true })
  if (error) throw error
  return data || []
}

async function countScopedMemories(client, scope) {
  if (!ALLOWED_SCOPES.has(scope)) throw new Error("EMBEDDING_SCOPE_NOT_ALLOWED")
  let query = client.from("memory_items").select("id", { count: "exact", head: true })
    .eq("user_id", "user").eq("lifecycle_status", "active")
  query = scope === "low_authority"
    ? query.eq("provenance_status", "legacy_unverified").eq("retrieval_tier", "low_authority").eq("authority_tier", "legacy_limited")
    : query.eq("origin_system", "xiaoc_native").in("provenance_status", ["verified_user", "manual_confirmed", "derived_verified"]).is("retrieval_tier", null).eq("authority_tier", "native_verified")
  const { count, error } = await query
  if (error) throw error
  return count || 0
}

export async function applyEmbeddings({ client, provider, options, logger = console }) {
  assertEmbeddingApplyAuthorization(options)
  const memories = await loadScopedMemories(client, options.scope)
  if (memories.length !== options.confirmCount) throw new Error(`EMBEDDING_SCOPE_COUNT_MISMATCH:${memories.length}`)
  const repository = new XiaoCMemoryEmbeddingRepository(client)
  let created = 0
  let activated = 0
  for (let offset = 0; offset < memories.length; offset += provider.maxBatchSize) {
    const batch = memories.slice(offset, offset + provider.maxBatchSize)
    const pending = []
    for (const memory of batch) {
      if (hashEmbeddingInput(memory.canonical_content) !== memory.content_hash) throw new Error(`MEMORY_CONTENT_HASH_MISMATCH:${memory.id}`)
      const active = await repository.readActive({ userId: memory.user_id, memoryId: memory.id })
      if (!active || embeddingStaleness(active, { ...provider, contentHash: memory.content_hash }).stale) pending.push(memory)
    }
    if (!pending.length) continue
    const vectors = await provider.embed(pending.map((memory) => memory.canonical_content))
    for (let index = 0; index < pending.length; index += 1) {
      const memory = pending[index]
      const embeddingId = await repository.registerShadow({
        userId: memory.user_id,
        memoryId: memory.id,
        contentHash: memory.content_hash,
        vector: vectors[index],
        identity: provider,
        policyVersion: EMBEDDING_POLICY_VERSION,
        idempotencyKey: `${provider.providerId}:${provider.modelId}:${provider.version}:${memory.id}:${memory.content_hash}`,
      })
      created += 1
      logger.log("EMBEDDING SHADOW REGISTERED:", { memory_id: memory.id, content_hash: memory.content_hash })
      await repository.activateShadow({
        userId: memory.user_id, embeddingId, policyVersion: EMBEDDING_POLICY_VERSION,
        idempotencyKey: `activate:${provider.providerId}:${provider.modelId}:${provider.version}:${memory.id}:${memory.content_hash}`,
      })
      const verified = await repository.readActive({ userId: memory.user_id, memoryId: memory.id })
      if (!verified || embeddingStaleness(verified, { ...provider, contentHash: memory.content_hash }).stale) throw new Error(`EMBEDDING_ACTIVATION_VERIFY_FAILED:${memory.id}`)
      activated += 1
    }
  }
  return { selected: memories.length, shadow_embeddings_registered: created, active_embeddings_verified: memories.length, newly_activated: activated }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseEmbeddingArgs(argv)
  if (options.mode === "dry-run") {
    console.log(JSON.stringify(dryRunSummary(options), null, 2))
    return
  }
  assertEmbeddingApplyAuthorization(options)
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("SUPABASE_CREDENTIALS_REQUIRED")
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  if (options.mode === "inventory") {
    console.log(JSON.stringify({ mode: "inventory", scope: options.scope, count: await countScopedMemories(client, options.scope) }))
    return
  }
  if (!process.env.OPENROUTER_API_KEY) throw new Error("EMBEDDING_PROVIDER_CONFIGURATION_REQUIRED")
  const provider = createXiaoCMemoryEmbeddingProvider({ env: process.env })
  console.log(await applyEmbeddings({ client, provider, options }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}

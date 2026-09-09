import { createClient } from "@supabase/supabase-js"
import { pathToFileURL } from "node:url"

import {
  createOpenAICompatibleEmbeddingProvider,
  hashEmbeddingInput,
  XiaoCMemoryEmbeddingRepository,
} from "../lib/xiaocMemoryEmbedding.js"

export const EMBEDDING_POLICY_VERSION = "xiaoc-memory-embedding-foundation-v1"
export const ALLOWED_SCOPES = new Set(["low_authority", "native_verified"])

export function parseEmbeddingArgs(argv) {
  const options = { mode: "dry-run", provider: "", model: "", version: "", dimension: null, scope: "", baseUrl: "", confirmCount: null }
  let explicitMode = false
  for (const arg of argv || []) {
    if (arg === "--dry-run" || arg === "--apply") {
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
    : query.in("provenance_status", ["verified_user", "manual_confirmed", "derived_verified"]).eq("authority_tier", "native_verified")
  const { data, error } = await query.order("id", { ascending: true })
  if (error) throw error
  return data || []
}

export async function applyEmbeddings({ client, provider, options, logger = console }) {
  assertEmbeddingApplyAuthorization(options)
  const memories = await loadScopedMemories(client, options.scope)
  if (memories.length !== options.confirmCount) throw new Error(`EMBEDDING_SCOPE_COUNT_MISMATCH:${memories.length}`)
  const repository = new XiaoCMemoryEmbeddingRepository(client)
  let created = 0
  for (let offset = 0; offset < memories.length; offset += provider.maxBatchSize) {
    const batch = memories.slice(offset, offset + provider.maxBatchSize)
    const vectors = await provider.embed(batch.map((memory) => memory.canonical_content))
    for (let index = 0; index < batch.length; index += 1) {
      const memory = batch[index]
      if (hashEmbeddingInput(memory.canonical_content) !== memory.content_hash) throw new Error(`MEMORY_CONTENT_HASH_MISMATCH:${memory.id}`)
      await repository.registerShadow({
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
    }
  }
  return { selected: memories.length, shadow_embeddings_registered: created }
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
  const apiKey = process.env.XIAOC_EMBEDDING_API_KEY
  const baseUrl = options.baseUrl || process.env.XIAOC_EMBEDDING_BASE_URL
  if (!url || !key) throw new Error("SUPABASE_CREDENTIALS_REQUIRED")
  if (!apiKey || !baseUrl) throw new Error("EMBEDDING_PROVIDER_CONFIGURATION_REQUIRED")
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const provider = createOpenAICompatibleEmbeddingProvider({
    providerId: options.provider,
    modelId: options.model,
    version: options.version,
    dimension: options.dimension,
    apiKey,
    baseUrl,
  })
  console.log(await applyEmbeddings({ client, provider, options }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}

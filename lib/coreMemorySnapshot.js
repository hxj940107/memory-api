import crypto from "node:crypto"

import { AI_ENDPOINTS } from "./aiConfig.js"
import {
  isOwnedAuthoritativeMode,
  isOwnedFreshEmptyMode,
} from "./memoryAuthority.js"

const SNAPSHOT_SEPARATOR = "\n\n---\n\n"

function normalizeStoredSnapshot(row) {
  if (!row?.core_memory_snapshot) return null

  return {
    snapshot: String(row.core_memory_snapshot),
    hash: String(row.core_memory_snapshot_hash || ""),
    createdAt: row.core_memory_snapshot_created_at || null,
    sourceBucketIds: Array.isArray(row.core_memory_source_bucket_ids)
      ? row.core_memory_source_bucket_ids.map(String)
      : [],
  }
}

function normalizeOwnedStoredSnapshot(row) {
  if (!row?.owned_core_memory_snapshot) return null

  const sources = Array.isArray(row.owned_core_memory_sources)
    ? row.owned_core_memory_sources.map(source => ({
        memoryId: String(source?.memory_id || ""),
        contentHash: String(source?.content_hash || ""),
      }))
    : []

  return {
    snapshot: String(row.owned_core_memory_snapshot),
    hash: String(row.owned_core_memory_snapshot_hash || ""),
    createdAt: row.owned_core_memory_snapshot_created_at || null,
    sourceBucketIds: sources.map(source => source.memoryId),
    sourceMemoryIds: sources.map(source => source.memoryId),
    sourceContentHashes: sources.map(source => source.contentHash),
    sources,
    authorityMode: "owned_authoritative",
  }
}

export function hashCoreMemorySnapshot(snapshot) {
  return crypto.createHash("sha256").update(String(snapshot || "")).digest("hex")
}

export function buildFreshEmptyCoreMemoryState(authorityMode = "owned_fresh_empty") {
  return Object.freeze({
    snapshot: "",
    hash: hashCoreMemorySnapshot(""),
    createdAt: null,
    sourceBucketIds: Object.freeze([]),
    authorityMode,
    empty: true,
  })
}

export function buildCoreMemorySnapshot(memories) {
  const normalized = (memories || [])
    .map(memory => ({
      id: String(memory?.id || "").trim(),
      content: String(memory?.content || ""),
    }))
    .filter(memory => memory.id && memory.content)
    .sort((left, right) => left.id.localeCompare(right.id))

  if (!normalized.length) {
    throw new Error("Ombre returned no complete pinned memories")
  }

  if (normalized.length !== memories.length) {
    throw new Error("Ombre returned an incomplete pinned memory")
  }

  const sourceBucketIds = normalized.map(memory => memory.id)
  const snapshot = normalized.map(memory => memory.content).join(SNAPSHOT_SEPARATOR)

  return {
    snapshot,
    hash: hashCoreMemorySnapshot(snapshot),
    sourceBucketIds,
  }
}

export function buildOwnedCoreMemorySnapshot(memories) {
  const normalized = (memories || [])
    .map(memory => ({
      id: String(memory?.id || memory?.memory_id || "").trim(),
      content: String(memory?.canonical_content || memory?.content || ""),
      contentHash: String(memory?.content_hash || "").trim(),
      ordinal: Number(memory?.ordinal),
    }))
    .filter(memory => memory.id && memory.content && memory.contentHash && Number.isInteger(memory.ordinal))
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))

  if (!normalized.length || normalized.length !== memories.length) {
    throw new Error("Owned Core returned an incomplete pinned memory")
  }
  if (new Set(normalized.map(memory => memory.id)).size !== normalized.length) {
    throw new Error("Owned Core returned duplicate pinned memory ids")
  }

  const snapshot = normalized.map(memory => memory.content).join(SNAPSHOT_SEPARATOR)
  const sources = normalized.map(memory => ({
    memory_id: memory.id,
    content_hash: memory.contentHash,
  }))

  return {
    snapshot,
    hash: hashCoreMemorySnapshot(snapshot),
    sourceBucketIds: sources.map(source => source.memory_id),
    sourceMemoryIds: sources.map(source => source.memory_id),
    sourceContentHashes: sources.map(source => source.content_hash),
    sources,
  }
}

function cookieHeader(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie()
      .map(cookie => cookie.split(";", 1)[0])
      .join("; ")
  }

  return String(response.headers.get("set-cookie") || "")
    .split(/,(?=[^;,]+=)/)
    .map(cookie => cookie.split(";", 1)[0])
    .join("; ")
}

async function fetchPinnedIds(fetchImpl) {
  const response = await fetchImpl(
    new URL("/xiaoc/memories", AI_ENDPOINTS.memoryBaseUrl),
  )
  const data = await response.json().catch(() => null)

  if (!response.ok || !Array.isArray(data?.memories)) {
    throw new Error(data?.error || `Unable to read Ombre memories: ${response.status}`)
  }

  const ids = data.memories
    .filter(memory => memory?.pinned)
    .map(memory => String(memory.id || "").trim())
    .filter(Boolean)
    .sort()

  if (!ids.length) throw new Error("Ombre returned no pinned memories")
  return ids
}

async function createAdminSession(fetchImpl) {
  if (!process.env.OMBRE_ADMIN_PASSWORD) {
    throw new Error("OMBRE_ADMIN_PASSWORD is required for complete PIN snapshots")
  }

  const response = await fetchImpl(
    new URL("/auth/login", AI_ENDPOINTS.memoryBaseUrl),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: process.env.OMBRE_ADMIN_PASSWORD }),
    },
  )
  const data = await response.json().catch(() => null)
  const cookie = cookieHeader(response)

  if (!response.ok || !cookie) {
    throw new Error(data?.error || `Ombre login failed: ${response.status}`)
  }

  return cookie
}

async function fetchMemoryDetail(fetchImpl, bucketId, cookie) {
  const response = await fetchImpl(
    new URL(`/api/bucket/${encodeURIComponent(bucketId)}`, AI_ENDPOINTS.memoryBaseUrl),
    { headers: { Cookie: cookie } },
  )
  const data = await response.json().catch(() => null)
  const content = String(data?.content || "")

  if (response.status === 404) {
    const error = new Error(data?.error || `Ombre memory ${bucketId} was not found`)
    error.code = "OMBRE_MEMORY_NOT_FOUND"
    error.bucketId = bucketId
    error.status = 404
    throw error
  }

  if (!response.ok || !content) {
    throw new Error(data?.error || `Unable to read complete Ombre memory ${bucketId}`)
  }

  return {
    id: bucketId,
    title: String(data?.title || "").trim(),
    content,
  }
}

export async function fetchCompleteMemoriesByIds(bucketIds, fetchImpl = fetch) {
  const ids = [...new Set((bucketIds || []).map(String).filter(Boolean))].sort()
  if (!ids.length) return []

  const cookie = await createAdminSession(fetchImpl)
  return Promise.all(ids.map(id => fetchMemoryDetail(fetchImpl, id, cookie)))
}

export async function fetchAvailableMemoriesByIds(bucketIds, fetchImpl = fetch) {
  const ids = [...new Set((bucketIds || []).map(String).filter(Boolean))].sort()
  if (!ids.length) {
    return {
      memories: [],
      staleSourceIds: [],
      exclusionLoadPartial: false,
    }
  }

  const cookie = await createAdminSession(fetchImpl)
  const results = await Promise.allSettled(
    ids.map(id => fetchMemoryDetail(fetchImpl, id, cookie))
  )
  const memories = []
  const staleSourceIds = []

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    if (result.status === "fulfilled") {
      memories.push(result.value)
      continue
    }
    if (result.reason?.code === "OMBRE_MEMORY_NOT_FOUND") {
      staleSourceIds.push(ids[index])
      continue
    }
    throw result.reason
  }

  return {
    memories,
    staleSourceIds,
    exclusionLoadPartial: staleSourceIds.length > 0,
  }
}

export function buildCoreMemoryExclusionIds(sourceBucketIds, legacyBucketIds = []) {
  return [...new Set([
    ...(sourceBucketIds || []).map(String),
    ...(legacyBucketIds || []).map(String),
  ].filter(Boolean))].sort()
}

export async function fetchCompletePinnedMemories(fetchImpl = fetch) {
  const firstIds = await fetchPinnedIds(fetchImpl)
  const cookie = await createAdminSession(fetchImpl)
  const firstMemories = await Promise.all(
    firstIds.map(id => fetchMemoryDetail(fetchImpl, id, cookie)),
  )
  const secondIds = await fetchPinnedIds(fetchImpl)

  if (firstIds.join("\n") !== secondIds.join("\n")) {
    throw new Error("Ombre pinned memories changed during snapshot creation")
  }

  const secondMemories = await Promise.all(
    secondIds.map(id => fetchMemoryDetail(fetchImpl, id, cookie)),
  )
  const firstHashes = firstMemories.map(memory => hashCoreMemorySnapshot(memory.content))
  const secondHashes = secondMemories.map(memory => hashCoreMemorySnapshot(memory.content))

  if (firstHashes.join("\n") !== secondHashes.join("\n")) {
    throw new Error("Ombre pinned memory content changed during snapshot creation")
  }

  return secondMemories
}

function validateStoredSnapshot(row) {
  const stored = normalizeStoredSnapshot(row)
  if (!stored) throw new Error("Core memory snapshot initialization returned no snapshot")
  if (hashCoreMemorySnapshot(stored.snapshot) !== stored.hash) {
    throw new Error("Stored core memory snapshot hash mismatch")
  }
  if (!stored.sourceBucketIds.length) {
    throw new Error("Stored core memory snapshot source ids are missing")
  }
  return stored
}

function validateOwnedStoredSnapshot(row) {
  const stored = normalizeOwnedStoredSnapshot(row)
  if (!stored) throw new Error("Owned Core snapshot initialization returned no snapshot")
  if (hashCoreMemorySnapshot(stored.snapshot) !== stored.hash) {
    throw new Error("Stored Owned Core snapshot hash mismatch")
  }
  if (!stored.sources.length
    || stored.sources.some(source => !source.memoryId || !/^[0-9a-f]{64}$/i.test(source.contentHash))
    || new Set(stored.sourceMemoryIds).size !== stored.sourceMemoryIds.length) {
    throw new Error("Stored Owned Core snapshot sources are invalid")
  }
  return stored
}

export function readStoredCoreMemorySnapshot(row, authorityMode = "ombre_authoritative") {
  if (isOwnedFreshEmptyMode(authorityMode)) return buildFreshEmptyCoreMemoryState(authorityMode)
  if (isOwnedAuthoritativeMode(authorityMode)) {
    return normalizeOwnedStoredSnapshot(row) ? validateOwnedStoredSnapshot(row) : null
  }
  return normalizeStoredSnapshot(row) ? validateStoredSnapshot(row) : null
}

export async function ensureCoreMemorySnapshot({
  conversationId,
  readSnapshot,
  initializeSnapshot,
  initializeOwnedSnapshot,
  fetchPinnedMemories = fetchCompletePinnedMemories,
  authorityMode = "ombre_authoritative",
}) {
  const existing = await readSnapshot(conversationId)
  if (isOwnedFreshEmptyMode(authorityMode)) {
    if (normalizeStoredSnapshot(existing)) {
      const error = new Error("Fresh-empty conversation contains a historical Core Memory snapshot")
      error.code = "FRESH_EMPTY_CORE_SNAPSHOT_CONFLICT"
      throw error
    }
    return buildFreshEmptyCoreMemoryState(authorityMode)
  }
  if (isOwnedAuthoritativeMode(authorityMode)) {
    const stored = readStoredCoreMemorySnapshot(existing, authorityMode)
    if (stored) return stored
    if (typeof initializeOwnedSnapshot !== "function") {
      throw new Error("Owned Core snapshot initializer is required")
    }
    return validateOwnedStoredSnapshot(await initializeOwnedSnapshot({ conversationId }))
  }
  const stored = readStoredCoreMemorySnapshot(existing, authorityMode)
  if (stored) return stored

  const memories = await fetchPinnedMemories()
  const candidate = buildCoreMemorySnapshot(memories)
  const createdAt = new Date().toISOString()
  const initialized = await initializeSnapshot({
    conversationId,
    ...candidate,
    createdAt,
  })

  return validateStoredSnapshot(initialized)
}

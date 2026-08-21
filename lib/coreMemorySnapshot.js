import crypto from "node:crypto"

import { AI_ENDPOINTS } from "./aiConfig.js"

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

export function hashCoreMemorySnapshot(snapshot) {
  return crypto.createHash("sha256").update(String(snapshot || "")).digest("hex")
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

  if (!response.ok || !content) {
    throw new Error(data?.error || `Unable to read complete Ombre memory ${bucketId}`)
  }

  return { id: bucketId, content }
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

export async function ensureCoreMemorySnapshot({
  conversationId,
  readSnapshot,
  initializeSnapshot,
  fetchPinnedMemories = fetchCompletePinnedMemories,
}) {
  const existing = await readSnapshot(conversationId)
  if (normalizeStoredSnapshot(existing)) return validateStoredSnapshot(existing)

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

export const XIAOC_MEMORY_OWNED_LIFECYCLE_POLICY_VERSION = "xiaoc-owned-lifecycle-shadow-v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LIST_STATUSES = new Set(["active", "archived", "deleted", "all"])
const MUTATION_ACTIONS = new Set(["archive", "delete", "clear"])
const MEMORY_LIBRARY_MAX_ROWS = 500

function requiredLegacyOwner(userId) {
  if (userId !== "user") throw Object.assign(new Error("OWNED_MEMORY_OWNER_MISMATCH"), { code: "OWNED_MEMORY_OWNER_MISMATCH" })
  return userId
}

function requiredUuid(value, code) {
  const normalized = String(value || "").trim().toLowerCase()
  if (!UUID.test(normalized)) throw Object.assign(new Error(code), { code })
  return normalized
}

function requiredIdempotencyKey(value) {
  const normalized = String(value || "").trim()
  if (!normalized || normalized.length > 200) {
    throw Object.assign(new Error("OWNED_MEMORY_IDEMPOTENCY_KEY_REQUIRED"), { code: "OWNED_MEMORY_IDEMPOTENCY_KEY_REQUIRED" })
  }
  return normalized
}

function rpcResult(data, error) {
  if (error) throw error
  return data
}

export function normalizeOwnedMemoryListStatus(value) {
  const normalized = String(value || "active").trim().toLowerCase()
  if (!LIST_STATUSES.has(normalized)) {
    throw Object.assign(new Error("OWNED_MEMORY_INVALID_LIFECYCLE_STATUS"), { code: "OWNED_MEMORY_INVALID_LIFECYCLE_STATUS" })
  }
  return normalized
}

export function normalizeOwnedMemoryLimit(value) {
  const parsed = Number.parseInt(String(value || "100"), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 100
  return Math.min(parsed, 200)
}

export function toOwnedMemoryView(row) {
  const content = String(row?.canonical_content || "")
  return {
    id: row.id,
    title: content.slice(0, 28) || "记忆",
    content,
    tags: row.category ? [row.category] : [],
    domains: [],
    type: row.memory_class || "observation",
    importance: Number(row.importance || 0),
    pinned: false,
    pinAvailable: false,
    editAvailable: false,
    score: 0,
    createdAt: row.created_at || "",
    lastActiveAt: row.updated_at || row.created_at || "",
    lifecycleStatus: row.lifecycle_status,
    revision: Number(row.revision || 0),
    archivedAt: row.archived_at || null,
    deletedAt: row.deleted_at || null,
  }
}

function memoryLibraryCandidate(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    canonical_content: row.canonical_content,
    origin_system: row.origin_system,
    memory_class: row.memory_class,
    category: row.category,
    provenance_status: row.provenance_status,
    lifecycle_status: row.lifecycle_status,
    retrieval_tier: row.retrieval_tier ?? null,
    authority_tier: row.authority_tier,
    claim_key: row.claim_key ?? null,
    importance: row.importance ?? null,
    confidence: row.confidence ?? null,
    event_time: row.event_time ?? null,
    valid_from: row.valid_from ?? null,
    valid_until: row.valid_until ?? null,
    resolved_at: row.resolved_at ?? null,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
    deleted_at: row.deleted_at,
  }
}

export async function listOwnedMemoryLibrary({ client, userId, retrievalTime = new Date().toISOString() }) {
  requiredLegacyOwner(userId)
  if (!Number.isFinite(Date.parse(retrievalTime))) {
    throw Object.assign(new Error("OWNED_MEMORY_RETRIEVAL_TIME_INVALID"), { code: "OWNED_MEMORY_RETRIEVAL_TIME_INVALID" })
  }

  const { data: rows, error: rowError } = await client
    .from("memory_items")
    .select("id,user_id,canonical_content,origin_system,memory_class,category,provenance_status,lifecycle_status,retrieval_tier,authority_tier,claim_key,importance,confidence,event_time,valid_from,valid_until,resolved_at,revision,created_at,updated_at,archived_at,deleted_at")
    .eq("user_id", userId)
    .eq("lifecycle_status", "active")
    .order("created_at", { ascending: false })
    .limit(MEMORY_LIBRARY_MAX_ROWS)
  if (rowError) throw rowError

  const candidates = (rows || []).map(memoryLibraryCandidate)
  if (!candidates.length) return []

  const { data: relations, error: relationError } = await client
    .from("memory_relations")
    .select("user_id,from_memory_id,to_memory_id,relation_type")
    .eq("user_id", userId)
    .in("relation_type", ["supersedes", "revalidates"])
    .limit(MEMORY_LIBRARY_MAX_ROWS)
  if (relationError) throw relationError

  const resolved = resolveMemoryCandidates({
    candidates,
    relations: relations || [],
    context: { userId, mode: "normal_current", retrievalTime },
  })

  return resolved.eligible_candidates
    .map(toOwnedMemoryView)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
}

export async function listOwnedMemories({ client, userId, lifecycleStatus = "active", limit = 100 }) {
  requiredLegacyOwner(userId)
  const { data, error } = await client.rpc("xiaoc_memory_list_owned", {
    p_user_id: userId,
    p_lifecycle_status: normalizeOwnedMemoryListStatus(lifecycleStatus),
    p_limit: normalizeOwnedMemoryLimit(limit),
  })
  return (rpcResult(data, error) || []).map(toOwnedMemoryView)
}

export async function mutateOwnedMemories({ client, userId, action, memoryId, idempotencyKey }) {
  requiredLegacyOwner(userId)
  if (!MUTATION_ACTIONS.has(action)) {
    throw Object.assign(new Error("OWNED_MEMORY_UNSUPPORTED_ACTION"), { code: "OWNED_MEMORY_UNSUPPORTED_ACTION" })
  }
  const params = {
    p_user_id: userId,
    p_policy_version: XIAOC_MEMORY_OWNED_LIFECYCLE_POLICY_VERSION,
    p_idempotency_key: requiredIdempotencyKey(idempotencyKey),
  }
  let rpcName
  if (action === "clear") {
    rpcName = "xiaoc_memory_clear_owned_active"
  } else {
    params.p_memory_id = requiredUuid(memoryId, "OWNED_MEMORY_ID_REQUIRED")
    rpcName = action === "archive" ? "xiaoc_memory_archive_owned" : "xiaoc_memory_delete_owned"
  }
  const { data, error } = await client.rpc(rpcName, params)
  return rpcResult(data, error)
}
import { resolveMemoryCandidates } from "./xiaocMemoryEligibility.js"

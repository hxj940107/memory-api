export const XIAOC_MEMORY_OWNED_LIFECYCLE_POLICY_VERSION = "xiaoc-owned-lifecycle-shadow-v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LIST_STATUSES = new Set(["active", "archived", "deleted", "all"])
const MUTATION_ACTIONS = new Set(["archive", "delete", "clear"])

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
    score: 0,
    createdAt: row.created_at || "",
    lastActiveAt: row.updated_at || row.created_at || "",
    lifecycleStatus: row.lifecycle_status,
    revision: Number(row.revision || 0),
    archivedAt: row.archived_at || null,
    deletedAt: row.deleted_at || null,
  }
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

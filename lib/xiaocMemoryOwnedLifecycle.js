import { resolveMemoryCandidates } from "./xiaocMemoryEligibility.js"

export const XIAOC_MEMORY_OWNED_LIFECYCLE_POLICY_VERSION = "xiaoc-owned-lifecycle-shadow-v1"
export const XIAOC_MEMORY_LIBRARY_MANAGEMENT_POLICY_VERSION = "xiaoc-memory-library-management-v1"

export const OWNED_MEMORY_UI_CATEGORIES = Object.freeze([
  Object.freeze({ canonical: "personal_fact", label: "关于你" }),
  Object.freeze({ canonical: "relationship_memory", label: "我们之间" }),
  Object.freeze({ canonical: "meaningful_experience", label: "一起经历过" }),
  Object.freeze({ canonical: "relationship_preference", label: "相处方式" }),
])

const UI_CATEGORY_BY_CANONICAL = new Map(
  OWNED_MEMORY_UI_CATEGORIES.map(({ canonical, label }) => [canonical, label])
)
const CANONICAL_CATEGORY_BY_UI = new Map(
  OWNED_MEMORY_UI_CATEGORIES.map(({ canonical, label }) => [label, canonical])
)

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

function ownedMemoryDisplayCategory(row) {
  const category = String(row?.category || "").trim().toLowerCase()
  if (UI_CATEGORY_BY_CANONICAL.has(category)) return UI_CATEGORY_BY_CANONICAL.get(category)
  // Existing native captures may still use this judge category. Keep it inside
  // the official four-category UI without inferring from private content.
  if (category === "long_term_concern") return "关于你"
  return "关于你"
}

export function normalizeOwnedMemoryCategory(value) {
  const normalized = String(value || "").trim()
  if (CANONICAL_CATEGORY_BY_UI.has(normalized)) return CANONICAL_CATEGORY_BY_UI.get(normalized)
  if (UI_CATEGORY_BY_CANONICAL.has(normalized)) return normalized
  throw Object.assign(new Error("OWNED_MEMORY_CATEGORY_INVALID"), { code: "OWNED_MEMORY_CATEGORY_INVALID" })
}

export function toOwnedMemoryView(row, pin = null) {
  const content = String(row?.canonical_content || "")
  const category = ownedMemoryDisplayCategory(row)
  return {
    id: row.id,
    content,
    category,
    pinned: Boolean(pin),
    pinOrdinal: pin ? Number(pin.ordinal) : null,
    pinAvailable: true,
    editAvailable: true,
    createdAt: row.created_at || "",
    lastActiveAt: row.updated_at || row.created_at || "",
    revision: Number(row.revision || 0),
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

  const eligible = resolved.eligible_candidates
  const eligibleIds = eligible.map(row => row.id)
  let pins = []
  if (eligibleIds.length) {
    const { data, error } = await client
      .from("memory_pins")
      .select("memory_id,ordinal")
      .eq("user_id", userId)
      .eq("scope", "core")
      .eq("pin_status", "active")
      .in("memory_id", eligibleIds)
      .order("ordinal", { ascending: true })
    if (error) throw error
    pins = data || []
  }
  const pinByMemoryId = new Map(pins.map(pin => [String(pin.memory_id), pin]))

  return eligible
    .map(row => toOwnedMemoryView(row, pinByMemoryId.get(String(row.id))))
    .sort((left, right) =>
      Number(right.pinned) - Number(left.pinned)
      || (left.pinOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.pinOrdinal ?? Number.MAX_SAFE_INTEGER)
      || String(right.lastActiveAt).localeCompare(String(left.lastActiveAt))
      || String(left.id).localeCompare(String(right.id))
    )
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

export async function setOwnedMemoryPin({ client, userId, memoryId, active, idempotencyKey }) {
  requiredLegacyOwner(userId)
  const normalizedMemoryId = requiredUuid(memoryId, "OWNED_MEMORY_ID_REQUIRED")
  const normalizedKey = requiredIdempotencyKey(idempotencyKey)
  const { data: existing, error: existingError } = await client
    .from("memory_pins")
    .select("memory_id,ordinal,pin_status")
    .eq("user_id", userId)
    .eq("scope", "core")
    .eq("memory_id", normalizedMemoryId)
    .maybeSingle()
  if (existingError) throw existingError

  let ordinal = !active || existing?.pin_status === "active"
    ? Number(existing?.ordinal)
    : Number.NaN
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    const { data: activePins, error: activeError } = await client
      .from("memory_pins")
      .select("ordinal")
      .eq("user_id", userId)
      .eq("scope", "core")
      .eq("pin_status", "active")
      .order("ordinal", { ascending: false })
      .limit(1)
    if (activeError) throw activeError
    ordinal = Math.max(-1, Number(activePins?.[0]?.ordinal ?? -1)) + 1
  }

  if (!active && existing?.pin_status !== "active") {
    return { memory_id: normalizedMemoryId, pinned: false, changed: false }
  }

  const { data, error } = await client.rpc("xiaoc_memory_set_pin", {
    p_user_id: userId,
    p_memory_id: normalizedMemoryId,
    p_active: Boolean(active),
    p_ordinal: ordinal,
    p_policy_version: XIAOC_MEMORY_LIBRARY_MANAGEMENT_POLICY_VERSION,
    p_idempotency_key: normalizedKey,
  })
  rpcResult(data, error)
  return { memory_id: normalizedMemoryId, pinned: Boolean(active), changed: true, operation_id: data }
}

export async function editOwnedMemory({
  client,
  userId,
  memoryId,
  content,
  category,
  expectedRevision,
  idempotencyKey,
}) {
  requiredLegacyOwner(userId)
  const normalizedContent = String(content || "").trim()
  if (!normalizedContent) {
    throw Object.assign(new Error("OWNED_MEMORY_CONTENT_REQUIRED"), { code: "OWNED_MEMORY_CONTENT_REQUIRED" })
  }
  const revision = Number(expectedRevision)
  if (!Number.isInteger(revision) || revision < 1) {
    throw Object.assign(new Error("OWNED_MEMORY_REVISION_REQUIRED"), { code: "OWNED_MEMORY_REVISION_REQUIRED" })
  }
  const { data, error } = await client.rpc("xiaoc_memory_edit_owned", {
    p_user_id: userId,
    p_memory_id: requiredUuid(memoryId, "OWNED_MEMORY_ID_REQUIRED"),
    p_canonical_content: normalizedContent,
    p_category: normalizeOwnedMemoryCategory(category),
    p_expected_revision: revision,
    p_policy_version: XIAOC_MEMORY_LIBRARY_MANAGEMENT_POLICY_VERSION,
    p_idempotency_key: requiredIdempotencyKey(idempotencyKey),
  })
  return rpcResult(Array.isArray(data) ? data[0] : data, error)
}

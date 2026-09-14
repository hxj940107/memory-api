import crypto from "crypto"

export const XIAOC_MEMORY_OBSERVATION_AUDIT_TABLE = "xiaoc_memory_observation_audit"
export const XIAOC_MEMORY_OBSERVATION_AUDIT_POLICY_VERSION = "xiaoc-memory-observation-audit-v1"

const HASH_PATTERN = /^[0-9a-f]{64}$/
const OUTCOMES = new Set(["skipped", "success", "empty", "failure", "timeout", "duplicate"])

const boundedText = (value, limit = 80) => {
  const text = String(value || "").trim()
  return text ? text.slice(0, limit) : null
}

const safeCount = value => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

const safeLatency = value => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(300_000, Math.round(number))) : null
}

function safeCountObject(value, maximumKeys = 16) {
  const entries = Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value : {})
    .slice(0, maximumKeys)
    .map(([key, count]) => [String(key).slice(0, 64), safeCount(count)])
  return Object.fromEntries(entries)
}

function safeLatencyObject(value) {
  const entries = Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value : {})
    .slice(0, 8)
    .flatMap(([key, latency]) => {
      const safe = safeLatency(latency)
      return safe === null ? [] : [[String(key).slice(0, 64), safe]]
    })
  return Object.fromEntries(entries)
}

export function isXiaoCMemoryObservationAuditEnabled(env = process.env) {
  return env?.XIAOC_MEMORY_OBSERVATION_AUDIT_ENABLED === "true"
}

export function buildXiaoCMemoryCorrelationHash(stableMessageId = null) {
  const source = String(stableMessageId || "").trim() || crypto.randomUUID()
  return crypto.createHash("sha256").update(source, "utf8").digest("hex")
}

function baseAuditRow({ env, userId, eventKind, correlationIdHash, outcome, reasonCode, errorCode }) {
  if (!HASH_PATTERN.test(String(correlationIdHash || ""))) throw new Error("OBSERVATION_CORRELATION_HASH_INVALID")
  if (!OUTCOMES.has(outcome)) throw new Error("OBSERVATION_OUTCOME_INVALID")
  return {
    user_id: String(userId || ""),
    occurred_at: new Date().toISOString(),
    event_kind: eventKind,
    environment: boundedText(env?.VERCEL_ENV || env?.NODE_ENV || "local", 32) || "local",
    deployment_id: boundedText(env?.VERCEL_DEPLOYMENT_ID || env?.VERCEL_GIT_COMMIT_SHA, 128),
    policy_version: XIAOC_MEMORY_OBSERVATION_AUDIT_POLICY_VERSION,
    correlation_id_hash: correlationIdHash,
    retrieval_mode: null,
    eligible_opportunity: false,
    sampled: false,
    attempted: false,
    outcome,
    reason_code: boundedText(reasonCode),
    error_code: boundedText(errorCode),
    candidate_count: 0,
    eligible_count: 0,
    selected_count: 0,
    selected_origin_counts: {},
    authority_counts: {},
    tier_counts: {},
    ombre_count: null,
    overlap_count: null,
    total_latency_ms: null,
    stage_latency_ms: {},
  }
}

export function buildXiaoCMemoryRetrievalAuditRow({ env = process.env, userId, telemetry }) {
  const selected = safeCount(telemetry?.xiaoc?.selected_count)
  const outcome = telemetry?.error_code === "TIMEOUT" ? "timeout"
    : telemetry?.error_code ? "failure"
      : telemetry?.skipped_reason ? "skipped"
        : selected > 0 ? "success" : "empty"
  return {
    ...baseAuditRow({
      env, userId, eventKind: "retrieval_shadow",
      correlationIdHash: telemetry?.correlation_id_hash,
      outcome, reasonCode: telemetry?.skipped_reason, errorCode: telemetry?.error_code,
    }),
    retrieval_mode: boundedText(telemetry?.retrieval_mode, 32),
    eligible_opportunity: telemetry?.eligible_opportunity === true,
    sampled: telemetry?.sampled === true,
    attempted: telemetry?.attempted === true,
    candidate_count: safeCount(telemetry?.xiaoc?.candidate_count),
    eligible_count: safeCount(telemetry?.xiaoc?.eligible_count),
    selected_count: selected,
    selected_origin_counts: safeCountObject(telemetry?.xiaoc?.origin_distribution),
    authority_counts: safeCountObject(telemetry?.xiaoc?.authority_distribution),
    tier_counts: safeCountObject(telemetry?.xiaoc?.tier_distribution),
    ombre_count: telemetry?.ombre ? safeCount(telemetry.ombre.count) : null,
    overlap_count: telemetry?.comparison ? safeCount(telemetry.comparison.overlap_count) : null,
    total_latency_ms: safeLatency(telemetry?.latency?.shadow_total_ms),
    stage_latency_ms: safeLatencyObject(telemetry?.latency),
  }
}

export function buildXiaoCMemoryNativeCaptureAuditRow({
  env = process.env, userId, correlationIdHash, eligibleOpportunity = false,
  attempted = false, sampled = attempted, outcome, reasonCode = null, errorCode = null, totalLatencyMs = null,
}) {
  return {
    ...baseAuditRow({
      env, userId, eventKind: "native_capture_shadow", correlationIdHash,
      outcome, reasonCode, errorCode,
    }),
    eligible_opportunity: eligibleOpportunity === true,
    sampled: sampled === true,
    attempted: attempted === true,
    total_latency_ms: safeLatency(totalLatencyMs),
  }
}

export async function bestEffortWriteXiaoCMemoryObservationAudit({
  client, env = process.env, row, logger = console,
}) {
  if (!isXiaoCMemoryObservationAuditEnabled(env)) return false
  try {
    if (!client?.from) throw Object.assign(new Error("AUDIT_CLIENT_UNAVAILABLE"), { code: "AUDIT_CLIENT_UNAVAILABLE" })
    const { error } = await client.from(XIAOC_MEMORY_OBSERVATION_AUDIT_TABLE).insert(row)
    if (error && !["42P01", "PGRST205"].includes(error.code)) throw error
    return !error
  } catch (error) {
    logger.warn?.("XIAOC MEMORY OBSERVATION AUDIT SKIPPED:", {
      event_kind: row?.event_kind || null,
      error_code: boundedText(error?.code || "AUDIT_WRITE_FAILED"),
    })
    return false
  }
}

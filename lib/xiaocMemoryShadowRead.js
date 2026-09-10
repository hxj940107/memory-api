import crypto from "crypto"

import { XiaoCMemoryDbRetrievalRepository } from "./xiaocMemoryDbRepository.js"
import { buildXiaoCMemoryQueryPlan } from "./xiaocMemoryQueryPlan.js"
import { retrieveXiaoCMemoriesOffline } from "./xiaocMemoryRanking.js"

const DEFAULT_TIMEOUT_MS = 350
const LOW_SIGNAL_MESSAGE = /^(?:你好|hi|hello|哈喽|在吗|嗯|哦|啊|哈哈+|谢谢|谢啦|好的|好|ok|收到|晚安|早安|拜拜|再见)[。！!~\s]*$/iu

const safeHash = value => crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex")
const boundedText = (value, limit) => String(value || "").trim().slice(0, limit)

export function getXiaoCMemoryShadowConfig(env = process.env) {
  const enabled = env?.XIAOC_MEMORY_SHADOW_READ_ENABLED === "true"
  const rawRate = Number(env?.XIAOC_MEMORY_SHADOW_SAMPLE_RATE ?? 0)
  const sampleRate = Number.isFinite(rawRate) ? Math.min(1, Math.max(0, rawRate)) : 0
  const rawTimeout = Number(env?.XIAOC_MEMORY_SHADOW_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.min(1500, Math.max(50, Math.round(rawTimeout))) : DEFAULT_TIMEOUT_MS
  return Object.freeze({ enabled, sampleRate, timeoutMs })
}

export function buildProductionShadowGrounding({ activeItems = [] } = {}) {
  const anchors = [...new Set((activeItems || []).flatMap(item => [item?.entity, item?.topic])
    .map(value => boundedText(value, 64)).filter(Boolean))].slice(0, 4)
  return Object.freeze({ strength: anchors.length ? "STRONG" : "NONE", anchors })
}

export function isXiaoCMemoryShadowSampled(correlationId, rate) {
  if (rate <= 0) return false
  if (rate >= 1) return true
  const bucket = Number.parseInt(safeHash(correlationId).slice(0, 8), 16) / 0x100000000
  return bucket < rate
}

function logTelemetry(logger, level, telemetry) {
  const writer = level === "warn" ? logger?.warn : logger?.log
  if (typeof writer === "function") writer.call(logger, "XIAOC MEMORY SHADOW:", telemetry)
  return telemetry
}

function decisionTelemetry({ correlationId, eligibleOpportunity, sampled = false, skippedReason, errorCode = null }) {
  return {
    event: "xiaoc_memory_shadow_read",
    attempted: false,
    sampled,
    eligible_opportunity: eligibleOpportunity,
    skipped_reason: skippedReason,
    correlation_id_hash: safeHash(correlationId),
    error_code: errorCode,
  }
}

function ombreEntries(values) {
  return (values || []).flatMap(value => String(value || "").split("\n---\n"))
    .map(value => value.replace(/^\[Ombre Brain - 相关记忆\]\s*/u, "").trim())
    .filter(Boolean)
}

export function normalizeOmbreShadowResults(values) {
  return ombreEntries(values).map((entry, index) => {
    const separator = entry.search(/[:：]/u)
    const content = separator >= 0 ? entry.slice(separator + 1).trim() : entry
    return { rank: index + 1, identity_hash: safeHash(content) }
  })
}

export function normalizeXiaoCShadowResults(results) {
  return (results || []).map((item, index) => ({
    rank: index + 1,
    identity_hash: String(item?.content_hash || "").match(/^[0-9a-f]{64}$/)?.[0] || safeHash(item?.memory_id),
    memory_id_hash: safeHash(item?.memory_id),
    retrieval_tier: item?.retrieval_tier ?? null,
    authority_tier: item?.authority_tier ?? "none",
    provenance_status: item?.provenance_status ?? "unknown",
    reason_codes: Array.isArray(item?.selection_reason_codes) ? item.selection_reason_codes : [],
  }))
}

function distribution(items, field) {
  const counts = {}
  for (const item of items) counts[item[field] ?? "none"] = (counts[item[field] ?? "none"] || 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

export function compareShadowResults(ombre, xiaoc) {
  const baseline = new Set(ombre.map(item => item.identity_hash))
  const shadow = new Set(xiaoc.map(item => item.identity_hash))
  const overlap = [...baseline].filter(id => shadow.has(id)).length
  const k = Math.min(3, ombre.length, xiaoc.length)
  const topKOverlap = k ? ombre.slice(0, k).filter(item => shadow.has(item.identity_hash)).length : 0
  return {
    overlap_count: overlap,
    baseline_only_count: [...baseline].filter(id => !shadow.has(id)).length,
    shadow_only_count: [...shadow].filter(id => !baseline.has(id)).length,
    top1_match: Boolean(ombre.length && xiaoc.length && ombre[0].identity_hash === xiaoc[0].identity_hash),
    top_k: k,
    top_k_overlap: topKOverlap,
    ombre_empty: ombre.length === 0,
    xiaoc_empty: xiaoc.length === 0,
  }
}

function withTiming(repository, latency) {
  const timed = name => async args => {
    const started = performance.now()
    try { return await repository[name](args) }
    finally { latency[`${name === "listLexicalCandidates" ? "lexical" : name === "listSemanticCandidates" ? "semantic" : "relation"}_rpc_ms`] = Math.round((performance.now() - started) * 1000) / 1000 }
  }
  return {
    listLexicalCandidates: timed("listLexicalCandidates"),
    listSemanticCandidates: timed("listSemanticCandidates"),
    listRelations: timed("listRelations"),
  }
}

export function classifyXiaoCMemoryShadowError(error) {
  const value = String(error?.message || "SHADOW_UNKNOWN_ERROR").split(":")[0]
  if (value === "SHADOW_TIMEOUT") return "TIMEOUT"
  if (/^RELATION_/u.test(value)) return "RELATION_ERROR"
  if (/^(?:LEXICAL|SEMANTIC)_RPC_FAILED$/u.test(value) || value === "SUPABASE_RPC_CLIENT_REQUIRED") return "DB_ERROR"
  if (/^(?:DB_CANDIDATE|LEXICAL_RPC_RESPONSE|SEMANTIC_RPC_RESPONSE|SEMANTIC_RPC_IDENTITY|RELATION_RPC_RESPONSE|RELATION_RPC_ROW)/u.test(value)) return "MALFORMED_RESPONSE"
  if (/^(?:RANKING|LEXICAL_CANDIDATES|SEMANTIC_CANDIDATES|RETRIEVAL_CHANNEL)/u.test(value)) return "RANKING_ERROR"
  return "RANKING_ERROR"
}

export async function runXiaoCMemoryShadowRead({
  env = process.env, client, trustedUserId, requestedUserId, message,
  correlationId, ombreResults = [], activeItems = [], now = () => new Date().toISOString(),
  logger = console, repository = null,
} = {}) {
  const config = getXiaoCMemoryShadowConfig(env)
  if (!config.enabled) return { attempted: false, skipped_reason: "FLAG_OFF" }
  if (!config.sampleRate) return { attempted: false, skipped_reason: "SAMPLE_RATE_ZERO" }
  if (!trustedUserId || requestedUserId !== trustedUserId) {
    return logTelemetry(logger, "warn", decisionTelemetry({
      correlationId, eligibleOpportunity: false, skippedReason: "TRUSTED_USER_MISSING", errorCode: "TRUSTED_USER_MISSING",
    }))
  }
  if (LOW_SIGNAL_MESSAGE.test(String(message || "").trim())) {
    return logTelemetry(logger, "log", decisionTelemetry({ correlationId, eligibleOpportunity: false, skippedReason: "QUERY_PLAN_SKIP" }))
  }

  const started = performance.now()
  const latency = { lexical_rpc_ms: null, semantic_rpc_ms: 0, relation_rpc_ms: null, ranking_ms: null }
  let queryPlan = null
  try {
    const grounding = buildProductionShadowGrounding({ activeItems })
    queryPlan = buildXiaoCMemoryQueryPlan(message, { grounding })
    if (!queryPlan.should_retrieve) {
      return logTelemetry(logger, "log", decisionTelemetry({ correlationId, eligibleOpportunity: false, skippedReason: "QUERY_PLAN_SKIP" }))
    }
    if (!isXiaoCMemoryShadowSampled(correlationId, config.sampleRate)) {
      return logTelemetry(logger, "log", decisionTelemetry({ correlationId, eligibleOpportunity: true, skippedReason: "NOT_SAMPLED" }))
    }

    const dbRepository = repository || new XiaoCMemoryDbRetrievalRepository(client, {
      retrievalMode: queryPlan.explicit_recall ? "historical_recall" : "normal_current",
      retrievalTime: now(),
    })
    const task = (async () => {
      const result = await retrieveXiaoCMemoriesOffline({
        repository: withTiming(dbRepository, latency), userId: trustedUserId, query: message,
        retrievalTime: now(), mode: queryPlan.explicit_recall ? "historical_recall" : "normal_current",
        explicitRecall: queryPlan.explicit_recall, channelMode: "lexical_only", retrievalContext: { grounding },
      })
      const retrievalTotal = Number(result.trace?.latency_ms?.total || 0)
      const rpcTotal = [latency.lexical_rpc_ms, latency.semantic_rpc_ms, latency.relation_rpc_ms]
        .reduce((sum, value) => sum + Number(value || 0), 0)
      latency.ranking_ms = Math.round(Math.max(0, retrievalTotal - rpcTotal) * 1000) / 1000
      return result
    })()
    let timeoutId
    const remainingTimeoutMs = Math.max(0, config.timeoutMs - (performance.now() - started))
    const result = await Promise.race([task, new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("SHADOW_TIMEOUT")), remainingTimeoutMs)
    })]).finally(() => clearTimeout(timeoutId))
    const ombre = normalizeOmbreShadowResults(ombreResults)
    const xiaoc = normalizeXiaoCShadowResults(result.results)
    const telemetry = {
      event: "xiaoc_memory_shadow_read", attempted: true, sampled: true, eligible_opportunity: true, skipped_reason: null,
      retrieval_mode: queryPlan.explicit_recall ? "historical_recall" : "normal_current",
      degradation_mode: result.trace?.degradation_mode || "LEXICAL_ONLY",
      correlation_id_hash: safeHash(correlationId), query_fingerprint: safeHash(queryPlan.retrieval_query),
      ombre: { count: ombre.length, identity_hashes: ombre.map(item => item.identity_hash) },
      xiaoc: {
        candidate_count: result.trace?.raw_candidate_count || 0,
        eligible_count: result.trace?.eligible_count || 0,
        selected_count: xiaoc.length,
        identity_hashes: xiaoc.map(item => item.identity_hash),
        authority_distribution: distribution(xiaoc, "authority_tier"),
        tier_distribution: distribution(xiaoc, "retrieval_tier"),
        reason_code_counts: result.trace?.reason_code_counts || {},
      },
      comparison: compareShadowResults(ombre, xiaoc),
      latency: { ...latency, shadow_total_ms: Math.round((performance.now() - started) * 1000) / 1000 },
      error_code: null,
    }
    return logTelemetry(logger, "log", telemetry)
  } catch (error) {
    const telemetry = {
      event: "xiaoc_memory_shadow_read", attempted: Boolean(queryPlan?.should_retrieve), sampled: Boolean(queryPlan?.should_retrieve),
      eligible_opportunity: Boolean(queryPlan?.should_retrieve), skipped_reason: queryPlan ? null : "QUERYPLAN_ERROR",
      retrieval_mode: queryPlan ? (queryPlan.explicit_recall ? "historical_recall" : "normal_current") : null,
      degradation_mode: queryPlan ? "LEXICAL_ONLY" : null, correlation_id_hash: safeHash(correlationId),
      ombre: { count: normalizeOmbreShadowResults(ombreResults).length },
      xiaoc: { candidate_count: 0, eligible_count: 0, selected_count: 0 },
      comparison: null,
      latency: { ...latency, shadow_total_ms: Math.round((performance.now() - started) * 1000) / 1000 },
      error_code: queryPlan ? classifyXiaoCMemoryShadowError(error) : "QUERYPLAN_ERROR",
    }
    return logTelemetry(logger, "warn", telemetry)
  }
}

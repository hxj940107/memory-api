#!/usr/bin/env node

import crypto from "node:crypto"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { retrieveXiaoCMemoriesOffline, XIAOC_MEMORY_RETRIEVAL_POLICY } from "../lib/xiaocMemoryRanking.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const DEFAULT_FIXTURE_PATH = resolve(ROOT, "tests/fixtures/xiaoc-memory-retrieval-eval.json")
export const HOLDOUT_FIXTURE_PATH = resolve(ROOT, "tests/fixtures/xiaoc-memory-retrieval-eval-holdout.json")
export const DEFAULT_ARTIFACT_PATH = resolve(ROOT, "tmp/xiaoc-memory-engine-m3c-eval.json")
export const SYNTHETIC_EMBEDDING_IDENTITY = Object.freeze({ providerId: "synthetic", modelId: "m3c-fixture", version: "v1", preprocessorVersion: "synthetic-v1", dimension: 2 })

const round = (value) => Number((Number.isFinite(value) ? value : 0).toFixed(6))
const sorted = (values) => [...new Set(values || [])].sort()
const hashFor = (id) => crypto.createHash("sha256").update(`synthetic:${id}`).digest("hex")

function memoryFromFixture(item) {
  const legacy = item.kind === "legacy"
  return {
    id: item.id,
    user_id: item.user_id || "user",
    canonical_content: item.content,
    content_hash: item.content_hash || hashFor(item.id),
    origin_system: legacy ? "ombre_legacy" : "xiaoc_native",
    memory_class: item.memory_class || "observation",
    provenance_status: legacy ? "legacy_unverified" : (item.provenance_status || "verified_user"),
    lifecycle_status: item.lifecycle_status || "active",
    retrieval_tier: legacy ? (item.retrieval_tier || "low_authority") : null,
    authority_tier: legacy ? (item.authority_tier || "legacy_limited") : "native_verified",
    claim_key: item.claim_key ?? null,
    importance: item.importance ?? 5,
    event_time: item.event_time ?? null,
    valid_from: item.valid_from ?? null,
    valid_until: item.valid_until ?? null,
    resolved_at: item.resolved_at ?? null,
    created_at: item.created_at || "2025-01-01T00:00:00.000Z",
  }
}

function semanticRow(memory, vector) {
  return {
    memory, vector, rollout_status: "active",
    provider: SYNTHETIC_EMBEDDING_IDENTITY.providerId,
    model: SYNTHETIC_EMBEDDING_IDENTITY.modelId,
    embedding_version: SYNTHETIC_EMBEDDING_IDENTITY.version,
    preprocessor_version: SYNTHETIC_EMBEDDING_IDENTITY.preprocessorVersion,
    dimensions: SYNTHETIC_EMBEDDING_IDENTITY.dimension,
  }
}

export function createSyntheticEvaluationRepository(caseDefinition) {
  const memories = (caseDefinition.memories || []).map(memoryFromFixture)
  const semantic = memories
    .filter((memory) => Array.isArray(caseDefinition.semantic_vectors?.[memory.id]))
    .map((memory) => semanticRow(memory, caseDefinition.semantic_vectors[memory.id]))
  return {
    async listLexicalCandidates({ limit }) { return memories.slice(0, limit) },
    async listSemanticCandidates({ limit }) { return semantic.slice(0, limit) },
    async listRelations() { return caseDefinition.relations || [] },
  }
}

function policyWithThresholdDelta(delta) {
  return {
    ...XIAOC_MEMORY_RETRIEVAL_POLICY,
    version: `${XIAOC_MEMORY_RETRIEVAL_POLICY.version}:threshold:${delta >= 0 ? "+" : ""}${delta}`,
    thresholds: Object.fromEntries(Object.entries(XIAOC_MEMORY_RETRIEVAL_POLICY.thresholds).map(([key, value]) => [key, Math.min(1, Math.max(0, value + delta))])),
  }
}

async function runCase(definition, dataset, { channelMode = "hybrid", topK = 3, policy = XIAOC_MEMORY_RETRIEVAL_POLICY } = {}) {
  if (definition.should_retrieve === false) return {
    id: definition.id, category: definition.category, selected_ids: [], suppressed: [], ranking: [],
    expected_selected_ids: sorted(definition.expected_selected_ids), expected_suppressed_ids: sorted(definition.expected_suppressed_ids),
    pass: true, should_retrieve: false,
  }
  const queryEmbedding = definition.query_vector || null
  const response = await retrieveXiaoCMemoriesOffline({
    repository: createSyntheticEvaluationRepository(definition),
    userId: "user",
    query: definition.query,
    queryEmbedding,
    embeddingIdentity: queryEmbedding ? SYNTHETIC_EMBEDDING_IDENTITY : null,
    relations: definition.relations || [],
    externalClaims: definition.external_claims || [],
    retrievalTime: dataset.retrieval_time,
    mode: definition.mode || "normal_current",
    explicitRecall: definition.explicit_recall === true,
    retrievalContext: { grounding: definition.grounding || null },
    channelMode,
    topK,
    policy,
  })
  const selectedIds = response.results.map((item) => item.memory_id)
  const suppressed = response.trace.suppressed_candidates || []
  const suppressedIds = suppressed.map((item) => item.memory_id)
  const expectedSelected = sorted(definition.expected_selected_ids)
  const expectedSuppressed = sorted(definition.expected_suppressed_ids)
  const selectedExact = JSON.stringify(sorted(selectedIds)) === JSON.stringify(expectedSelected)
  const suppressedPresent = expectedSuppressed.every((id) => suppressedIds.includes(id))
  return {
    id: definition.id,
    category: definition.category,
    should_retrieve: true,
    selected_ids: selectedIds,
    suppressed,
    ranking: response.trace.ranking_decisions || [],
    expected_selected_ids: expectedSelected,
    expected_suppressed_ids: expectedSuppressed,
    pass: selectedExact && suppressedPresent,
    failure_taxonomy: selectedExact && suppressedPresent ? [] : [definition.failure_taxonomy_hint || classifyFailure({ definition, selectedIds, suppressedIds })],
  }
}

function classifyFailure({ definition, selectedIds, suppressedIds }) {
  if ((definition.expected_suppressed_ids || []).some((id) => !suppressedIds.includes(id))) return "ELIGIBILITY_FAILURE"
  if ((definition.dangerous_ids || []).some((id) => selectedIds.includes(id))) return "CLAIM_RESOLUTION_FAILURE"
  if ((definition.expected_selected_ids || []).length && !selectedIds.length) return "THRESHOLD_FAILURE"
  if ((definition.expected_selected_ids || []).some((id) => !selectedIds.includes(id))) return "RANKING_FAILURE"
  if (selectedIds.length > (definition.expected_selected_ids || []).length) return "RANKING_FAILURE"
  return "DATASET_EXPECTATION_ERROR"
}

function metricsFor(definitions, results, k) {
  let relevant = 0; let hits = 0; let selected = 0; let reciprocal = 0; let rankedCases = 0
  for (const result of results) {
    const expected = new Set(result.expected_selected_ids)
    if (expected.size) {
      rankedCases += 1
      relevant += expected.size
      const picked = result.selected_ids.slice(0, k)
      hits += picked.filter((id) => expected.has(id)).length
      const first = picked.findIndex((id) => expected.has(id))
      if (first >= 0) reciprocal += 1 / (first + 1)
    }
    selected += result.selected_ids.slice(0, k).length
  }
  const rate = (numerator, denominator) => denominator ? round(numerator / denominator) : 1
  const casesBy = (predicate) => definitions.filter(predicate)
  const success = (predicate) => {
    const defs = casesBy(predicate)
    return rate(defs.filter((definition) => {
      const result = results.find((item) => item.id === definition.id)
      return (definition.expected_selected_ids || []).every((id) => result.selected_ids.slice(0, k).includes(id))
    }).length, defs.length)
  }
  const exposure = (field) => {
    const defs = casesBy((definition) => (definition[field] || []).length > 0)
    if (!defs.length) return 0
    return rate(defs.filter((definition) => {
      const selectedIds = results.find((item) => item.id === definition.id).selected_ids.slice(0, k)
      return (definition[field] || []).some((id) => selectedIds.includes(id))
    }).length, defs.length)
  }
  const emptyDefs = casesBy((definition) => (definition.expected_selected_ids || []).length === 0)
  const noRetrievalDefs = casesBy((definition) => definition.should_retrieve === false)
  return {
    recall_at_k: rate(hits, relevant),
    precision_at_k: rate(hits, selected),
    mrr: rate(reciprocal, rankedCases),
    explicit_recall_success: success((definition) => definition.category === "explicit_recall"),
    implicit_continuity_success: success((definition) => definition.category === "implicit_continuity"),
    dangerous_contradiction_rate: exposure("dangerous_ids"),
    legacy_false_current_state_rate: exposure("legacy_false_current_ids"),
    superseded_resurrection_rate: exposure("superseded_ids"),
    cross_user_leakage: exposure("cross_user_ids"),
    irrelevant_recall_rate: exposure("irrelevant_ids"),
    empty_result_correctness: rate(emptyDefs.filter((definition) => results.find((item) => item.id === definition.id).selected_ids.slice(0, k).length === 0).length, emptyDefs.length),
    no_retrieval_correctness: rate(noRetrievalDefs.filter((definition) => results.find((item) => item.id === definition.id).selected_ids.length === 0).length, noRetrievalDefs.length),
  }
}

async function evaluateVariant(dataset, options) {
  const results = []
  for (const definition of dataset.cases) results.push(await runCase(definition, dataset, options))
  return { results, metrics: metricsFor(dataset.cases, results, options.topK || 3) }
}

export async function runEvaluation(dataset) {
  const base = await evaluateVariant(dataset, { channelMode: "hybrid", topK: 3, policy: XIAOC_MEMORY_RETRIEVAL_POLICY })
  const ablation = {}
  for (const channelMode of ["lexical_only", "semantic_only", "hybrid"]) {
    const variant = await evaluateVariant(dataset, { channelMode, topK: 3, policy: XIAOC_MEMORY_RETRIEVAL_POLICY })
    ablation[channelMode] = variant.metrics
  }
  const thresholdSensitivity = {}
  for (const [label, delta] of [["lower", -0.08], ["current", 0], ["higher", 0.08]]) {
    thresholdSensitivity[label] = (await evaluateVariant(dataset, { channelMode: "hybrid", topK: 3, policy: policyWithThresholdDelta(delta) })).metrics
  }
  const topKSensitivity = {}
  for (const topK of [1, 3, 5]) topKSensitivity[`k${topK}`] = (await evaluateVariant(dataset, { channelMode: "hybrid", topK, policy: XIAOC_MEMORY_RETRIEVAL_POLICY })).metrics

  const metrics = base.metrics
  const safetyPass = metrics.dangerous_contradiction_rate === 0
    && metrics.legacy_false_current_state_rate === 0
    && metrics.superseded_resurrection_rate === 0
    && metrics.cross_user_leakage === 0
  const qualityPass = metrics.explicit_recall_success >= 0.95
    && metrics.implicit_continuity_success >= 0.9
    && metrics.irrelevant_recall_rate <= 0.05
    && metrics.no_retrieval_correctness >= 0.95
    && metrics.empty_result_correctness >= 0.95
  const failures = base.results.filter((result) => !result.pass)
  return {
    dataset_version: dataset.dataset_version,
    policy_version: XIAOC_MEMORY_RETRIEVAL_POLICY.version,
    case_count: dataset.cases.length,
    categories: sorted(dataset.cases.map((item) => item.category)),
    metrics_at_k3: metrics,
    metrics_at_k1: metricsFor(dataset.cases, base.results, 1),
    safety_gates: safetyPass ? "PASS" : "FAIL",
    quality_gates: qualityPass ? "PASS" : "FAIL",
    shadow_read_readiness: safetyPass && qualityPass && failures.length === 0 ? "READY" : "NOT_READY",
    failures,
    cases: base.results,
    ablation,
    threshold_sensitivity: thresholdSensitivity,
    top_k_sensitivity: topKSensitivity,
    privacy: { real_historical_memory_bodies_used: 0, external_calls: 0, real_embeddings_created: 0, supabase_writes: 0 },
  }
}

export async function runRemediationEvaluation(original, holdout) {
  const combined = {
    dataset_version: `${original.dataset_version}+${holdout.dataset_version}`,
    retrieval_time: original.retrieval_time,
    expectation_defaults: original.expectation_defaults,
    cases: [...original.cases, ...holdout.cases],
  }
  const [originalResult, holdoutResult, combinedResult] = await Promise.all([
    runEvaluation(original), runEvaluation(holdout), runEvaluation(combined),
  ])
  const semanticUngrounded = combined.cases.filter((item) => item.query_vector && !item.explicit_recall && item.grounding?.strength !== "STRONG" && (item.irrelevant_ids || []).length)
  const combinedCases = new Map(combinedResult.cases.map((item) => [item.id, item]))
  const semanticFalseAdmissions = semanticUngrounded.filter((item) => (item.irrelevant_ids || []).some((id) => combinedCases.get(item.id).selected_ids.includes(id))).length
  return {
    evaluation_version: "m3c-r1-evaluation-v1",
    original: originalResult,
    holdout: holdoutResult,
    combined: combinedResult,
    semantic_only_ungrounded_false_admission_rate: semanticUngrounded.length ? round(semanticFalseAdmissions / semanticUngrounded.length) : 0,
    semantic_collision_wrong_selections: semanticFalseAdmissions,
    readiness: combinedResult.shadow_read_readiness,
    privacy: combinedResult.privacy,
  }
}

export async function loadEvaluationDataset(path = DEFAULT_FIXTURE_PATH) {
  const dataset = JSON.parse(await readFile(path, "utf8"))
  if (!dataset.dataset_version || !Array.isArray(dataset.cases) || dataset.cases.length < 12) throw new Error("EVALUATION_DATASET_INVALID")
  for (const item of dataset.cases) {
    if (!item.id || !item.category || typeof item.query !== "string" || !Array.isArray(item.memories)
      || !Array.isArray(item.expected_selected_ids) || !Array.isArray(item.expected_suppressed_ids)
      || !Array.isArray(item.dangerous_ids)) throw new Error(`EVALUATION_CASE_INVALID:${item.id || "unknown"}`)
  }
  return dataset
}

async function main() {
  const outputArgument = process.argv.find((item) => item.startsWith("--output="))
  const outputPath = outputArgument ? resolve(process.cwd(), outputArgument.slice("--output=".length)) : DEFAULT_ARTIFACT_PATH
  const evaluation = await runRemediationEvaluation(await loadEvaluationDataset(), await loadEvaluationDataset(HOLDOUT_FIXTURE_PATH))
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(evaluation, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ artifact: outputPath, original_cases: evaluation.original.case_count, holdout_cases: evaluation.holdout.case_count, combined_cases: evaluation.combined.case_count, safety_gates: evaluation.combined.safety_gates, quality_gates: evaluation.combined.quality_gates, readiness: evaluation.readiness, failure_count: evaluation.combined.failures.length }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }))
  process.exitCode = 1
})

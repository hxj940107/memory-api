import assert from "node:assert/strict"
import test from "node:test"
import { readFile, stat } from "node:fs/promises"

import {
  DEFAULT_ARTIFACT_PATH,
  HOLDOUT_FIXTURE_PATH,
  loadEvaluationDataset,
  runEvaluation,
  runRemediationEvaluation,
} from "../scripts/xiaoc-memory-engine-eval.js"

test("M3C dataset is synthetic, machine-checkable, and covers at least thirteen categories", async () => {
  const dataset = await loadEvaluationDataset()
  assert.equal(dataset.cases.length, 24)
  assert.ok(new Set(dataset.cases.map((item) => item.category)).size >= 13)
  for (const item of dataset.cases) {
    assert.ok(Array.isArray(item.expected_selected_ids))
    assert.ok(Array.isArray(item.expected_suppressed_ids))
    assert.ok(Array.isArray(item.dangerous_ids))
    assert.equal(typeof item.query, "string")
  }
  assert.deepEqual(dataset.expectation_defaults.expected_reason_codes, [])
})

test("remediated original evaluation reruns are byte-stable and passes unchanged expectations", async () => {
  const dataset = await loadEvaluationDataset()
  const first = await runEvaluation(dataset)
  const second = await runEvaluation(dataset)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.equal(first.safety_gates, "PASS")
  assert.equal(first.quality_gates, "PASS")
  assert.equal(first.shadow_read_readiness, "READY")
  assert.deepEqual(first.failures, [])
})

test("all highest-priority safety metrics remain zero", async () => {
  const result = await runEvaluation(await loadEvaluationDataset())
  for (const key of ["dangerous_contradiction_rate", "legacy_false_current_state_rate", "superseded_resurrection_rate", "cross_user_leakage"]) {
    assert.equal(result.metrics_at_k3[key], 0, key)
  }
})

test("ablation, threshold, and top-k sensitivity are all reported", async () => {
  const result = await runEvaluation(await loadEvaluationDataset())
  assert.deepEqual(Object.keys(result.ablation), ["lexical_only", "semantic_only", "hybrid"])
  assert.deepEqual(Object.keys(result.threshold_sensitivity), ["lower", "current", "higher"])
  assert.deepEqual(Object.keys(result.top_k_sensitivity), ["k1", "k3", "k5"])
  assert.equal(result.ablation.lexical_only.precision_at_k, 1)
  assert.equal(result.ablation.hybrid.irrelevant_recall_rate, 0)
})

test("independent holdout and combined evaluation pass without changing original expectations", async () => {
  const original = await loadEvaluationDataset()
  const holdout = await loadEvaluationDataset(HOLDOUT_FIXTURE_PATH)
  assert.equal(holdout.cases.length, 12)
  assert.ok(holdout.cases.filter((item) => !/trip|travel|island/i.test(JSON.stringify(item))).length >= 6)
  const result = await runRemediationEvaluation(original, holdout)
  assert.equal(result.original.case_count, 24)
  assert.equal(result.holdout.case_count, 12)
  assert.equal(result.combined.case_count, 36)
  assert.equal(result.original.quality_gates, "PASS")
  assert.equal(result.holdout.quality_gates, "PASS")
  assert.equal(result.combined.quality_gates, "PASS")
  assert.equal(result.semantic_only_ungrounded_false_admission_rate, 0)
  assert.equal(result.semantic_collision_wrong_selections, 0)
})

test("privacy-safe artifact contains no fixture query or Memory body", async () => {
  const dataset = await loadEvaluationDataset()
  const holdout = await loadEvaluationDataset(HOLDOUT_FIXTURE_PATH)
  const artifactText = await readFile(DEFAULT_ARTIFACT_PATH, "utf8")
  const artifact = JSON.parse(artifactText)
  assert.equal(artifact.original.case_count, dataset.cases.length)
  for (const item of [...dataset.cases, ...holdout.cases]) {
    assert.equal(artifactText.includes(item.query), false, `query:${item.id}`)
    for (const memory of item.memories) assert.equal(artifactText.includes(memory.content), false, `content:${item.id}:${memory.id}`)
  }
  assert.equal((await stat(DEFAULT_ARTIFACT_PATH)).mode & 0o077, 0)
  assert.deepEqual(artifact.privacy, { real_historical_memory_bodies_used: 0, external_calls: 0, real_embeddings_created: 0, supabase_writes: 0 })
})

test("evaluation code has no external client and remains disconnected from production APIs", async () => {
  const source = await readFile(new URL("../scripts/xiaoc-memory-engine-eval.js", import.meta.url), "utf8")
  assert.equal(/fetch\s*\(|createClient\s*\(|\.rpc\s*\(/.test(source), false)
  const { readdir } = await import("node:fs/promises")
  for (const file of await readdir(new URL("../api/", import.meta.url))) {
    if (!file.endsWith(".js")) continue
    const apiSource = await readFile(new URL(`../api/${file}`, import.meta.url), "utf8")
    assert.equal(apiSource.includes("xiaoc-memory-engine-eval"), false, file)
  }
})

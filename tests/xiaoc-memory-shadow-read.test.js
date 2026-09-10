import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"

import {
  buildProductionShadowGrounding,
  compareShadowResults,
  getXiaoCMemoryShadowConfig,
  normalizeOmbreShadowResults,
  normalizeXiaoCShadowResults,
  runXiaoCMemoryShadowRead,
} from "../lib/xiaocMemoryShadowRead.js"

const USER = "user"
const NOW = "2026-09-10T00:00:00.000Z"
const content = "一起去海岛旅行"
const hash = "c14194de84adbe0a30d1a3d7aa1fc809890fac889d1cc7fae3bc32a13a2361cf"

function memory(overrides = {}) {
  return {
    id: "10000000-0000-0000-0000-000000000001", user_id: USER,
    canonical_content: content, content_hash: hash, origin_system: "ombre_legacy",
    memory_class: "observation", category: "event", provenance_status: "legacy_unverified",
    lifecycle_status: "active", retrieval_tier: "low_authority", authority_tier: "legacy_limited",
    claim_key: null, importance: 5, confidence: 1, event_time: null, valid_from: null,
    valid_until: null, resolved_at: null, created_at: NOW, ...overrides,
  }
}

function repository({ rows = [memory()], error = null, delay = 0 } = {}) {
  const calls = []
  return {
    calls,
    async listLexicalCandidates(args) {
      calls.push(["lexical", args])
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      if (error) throw error
      return rows
    },
    async listSemanticCandidates(args) { calls.push(["semantic", args]); return [] },
    async listRelations(args) { calls.push(["relations", args]); return [] },
  }
}

function logger() {
  return { entries: [], log(label, value) { this.entries.push([label, value]) }, warn(label, value) { this.entries.push([label, value]) } }
}

const enabled = { XIAOC_MEMORY_SHADOW_READ_ENABLED: "true", XIAOC_MEMORY_SHADOW_SAMPLE_RATE: "1", XIAOC_MEMORY_SHADOW_TIMEOUT_MS: "200" }

test("feature flag defaults OFF and sample zero performs no DB or telemetry work", async () => {
  assert.deepEqual(getXiaoCMemoryShadowConfig({}), { enabled: false, sampleRate: 0, timeoutMs: 350 })
  for (const env of [{}, { XIAOC_MEMORY_SHADOW_READ_ENABLED: "true", XIAOC_MEMORY_SHADOW_SAMPLE_RATE: "0" }]) {
    const repo = repository(); const log = logger()
    const result = await runXiaoCMemoryShadowRead({ env, repository: repo, trustedUserId: USER, requestedUserId: USER, message: "海岛", correlationId: "r1", logger: log })
    assert.equal(result.attempted, false)
    assert.equal(repo.calls.length, 0)
    assert.equal(log.entries.length, 0)
  }
})

test("deterministic sampling selects safely without random state", async () => {
  const repo = repository(); const log = logger()
  const result = await runXiaoCMemoryShadowRead({ env: enabled, repository: repo, trustedUserId: USER, requestedUserId: USER, message: "海岛", correlationId: "selected", logger: log, now: () => NOW })
  assert.equal(result.attempted, true)
  assert.equal(repo.calls[0][0], "lexical")
  assert.equal(repo.calls.some(([name]) => name === "semantic"), false)
})

test("missing or mismatched trusted user scope fails closed", async () => {
  for (const scope of [{ trustedUserId: "", requestedUserId: USER }, { trustedUserId: USER, requestedUserId: "other" }]) {
    const repo = repository()
    const result = await runXiaoCMemoryShadowRead({ env: enabled, repository: repo, ...scope, message: "海岛", correlationId: "scope" })
    assert.equal(result.skipped_reason, "TRUSTED_USER_SCOPE_MISSING")
    assert.equal(repo.calls.length, 0)
  }
})

test("query plan skips greetings and grounding adapter is bounded", async () => {
  const repo = repository()
  const result = await runXiaoCMemoryShadowRead({ env: enabled, repository: repo, trustedUserId: USER, requestedUserId: USER, message: "嗯", correlationId: "skip" })
  assert.equal(result.skipped_reason, "QUERY_PLAN_SKIP")
  assert.equal(repo.calls.length, 0)
  assert.deepEqual(buildProductionShadowGrounding({ activeItems: Array.from({ length: 8 }, (_, i) => ({ topic: `topic-${i}` })) }).anchors.length, 4)
})

test("zero embeddings is normal lexical-only degradation", async () => {
  const result = await runXiaoCMemoryShadowRead({ env: enabled, repository: repository(), trustedUserId: USER, requestedUserId: USER, message: "海岛", correlationId: "lexical", now: () => NOW, logger: logger() })
  assert.equal(result.error_code, null)
  assert.equal(result.degradation_mode, "LEXICAL_ONLY")
})

test("comparison covers exact, partial, none, empty, one-sided and rank differences", () => {
  const item = id => ({ identity_hash: id })
  assert.deepEqual(compareShadowResults([item("a")], [item("a")]), { overlap_count: 1, baseline_only_count: 0, shadow_only_count: 0, top1_match: true, top_k: 1, top_k_overlap: 1, ombre_empty: false, xiaoc_empty: false })
  assert.equal(compareShadowResults([item("a"), item("b")], [item("b"), item("c")]).overlap_count, 1)
  assert.equal(compareShadowResults([item("a")], [item("b")]).overlap_count, 0)
  assert.equal(compareShadowResults([], []).ombre_empty, true)
  assert.equal(compareShadowResults([item("a")], []).baseline_only_count, 1)
  assert.equal(compareShadowResults([], [item("a")]).shadow_only_count, 1)
  assert.equal(compareShadowResults([item("a"), item("b")], [item("b"), item("a")]).top1_match, false)
})

test("DB failure, malformed cross-user rows and timeout are isolated", async () => {
  const cases = [
    { repo: repository({ error: new Error("LEXICAL_RPC_FAILED:500") }), code: "LEXICAL_RPC_FAILED" },
    { repo: repository({ error: new Error("DB_CANDIDATE_USER_OR_ID_INVALID") }), code: "DB_CANDIDATE_USER_OR_ID_INVALID" },
    { repo: repository({ delay: 80 }), env: { ...enabled, XIAOC_MEMORY_SHADOW_TIMEOUT_MS: "50" }, code: "SHADOW_TIMEOUT" },
  ]
  for (const item of cases) {
    const result = await runXiaoCMemoryShadowRead({ env: item.env || enabled, repository: item.repo, trustedUserId: USER, requestedUserId: USER, message: "海岛", correlationId: item.code, now: () => NOW, logger: logger() })
    assert.equal(result.attempted, true)
    assert.equal(result.error_code, item.code)
  }
})

test("normalization and telemetry contain hashes and counts, never bodies or raw query", async () => {
  const ombre = normalizeOmbreShadowResults([`[Ombre Brain - 相关记忆]\n标题：${content}`])
  const xiaoc = normalizeXiaoCShadowResults([{ memory_id: "id", content_hash: ombre[0].identity_hash, retrieval_tier: "low_authority", authority_tier: "legacy_limited" }])
  assert.equal(compareShadowResults(ombre, xiaoc).top1_match, true)
  const log = logger()
  const result = await runXiaoCMemoryShadowRead({ env: enabled, repository: repository(), trustedUserId: USER, requestedUserId: USER, message: "海岛", correlationId: "privacy", ombreResults: [`标题：${content}`], now: () => NOW, logger: log })
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(content), false)
  assert.equal(serialized.includes("海岛"), false)
  assert.equal(serialized.includes("canonical_content"), false)
  assert.equal(log.entries.length, 1)
})

test("shadow harness is read-only and cannot change production prompt/context inputs", async () => {
  const repo = repository(); const before = { dynamicMemory: ["baseline"], active: [{ topic: "旅行" }], prompt: ["system", "user"] }
  const snapshot = structuredClone(before)
  await runXiaoCMemoryShadowRead({ env: enabled, repository: repo, trustedUserId: USER, requestedUserId: USER, message: "海岛", correlationId: "immutable", ombreResults: before.dynamicMemory, activeItems: before.active, now: () => NOW, logger: logger() })
  assert.deepEqual(before, snapshot)
  assert.deepEqual(repo.calls.map(([name]) => name), ["lexical", "relations"])
  assert.equal(repo.calls.some(([name]) => /create|update|write|pin|embedding/i.test(name)), false)
})

test("production wiring is waitUntil-only after Ombre and has no cutover path", async () => {
  const chat = await readFile(new URL("../api/chat.js", import.meta.url), "utf8")
  const call = chat.indexOf("waitUntil(runXiaoCMemoryShadowRead({")
  const ombre = chat.lastIndexOf("dynamicMemory = memoryResult.dynamicMemory", call)
  const prompt = chat.indexOf("const dynamicPromptContext", call)
  assert.ok(ombre >= 0 && call > ombre && prompt > call)
  assert.equal(chat.includes("await runXiaoCMemoryShadowRead"), false)
  assert.equal(/USE_XIAOC_MEMORY|XIAOC_PRIMARY_RETRIEVAL|fallback_to_xiaoc|merge_xiaoc/i.test(chat), false)
  assert.equal((chat.match(/runXiaoCMemoryShadowRead/g) || []).length, 2)
})

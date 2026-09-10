import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyXiaoCMemoryShadowError,
  getXiaoCMemoryShadowConfig,
  isXiaoCMemoryShadowSampled,
  runXiaoCMemoryShadowRead,
} from "../lib/xiaocMemoryShadowRead.js"

const USER = "user"
const NOW = "2026-09-10T00:00:00.000Z"
const enabled = rate => ({
  XIAOC_MEMORY_SHADOW_READ_ENABLED: "true",
  XIAOC_MEMORY_SHADOW_SAMPLE_RATE: String(rate),
  XIAOC_MEMORY_SHADOW_TIMEOUT_MS: "350",
})

function logger() {
  return { entries: [], log(label, value) { this.entries.push([label, value]) }, warn(label, value) { this.entries.push([label, value]) } }
}

function repository({ delay = 0, error = null, rows = [] } = {}) {
  const calls = []
  return {
    calls,
    async listLexicalCandidates() {
      calls.push("lexical")
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      if (error) throw error
      return rows
    },
    async listSemanticCandidates() { calls.push("semantic"); return [] },
    async listRelations() { calls.push("relation"); return [] },
  }
}

function args(overrides = {}) {
  return {
    env: enabled(1), repository: repository(), trustedUserId: USER, requestedUserId: USER,
    message: "海岛旅行", correlationId: "m3d1", now: () => NOW, logger: logger(), ...overrides,
  }
}

test("invalid flags, rates and timeouts fail safe without accidental full rollout", () => {
  assert.equal(getXiaoCMemoryShadowConfig({ XIAOC_MEMORY_SHADOW_READ_ENABLED: "TRUE", XIAOC_MEMORY_SHADOW_SAMPLE_RATE: "1" }).enabled, false)
  assert.equal(getXiaoCMemoryShadowConfig({ XIAOC_MEMORY_SHADOW_READ_ENABLED: "1", XIAOC_MEMORY_SHADOW_SAMPLE_RATE: "1" }).enabled, false)
  assert.equal(getXiaoCMemoryShadowConfig(enabled("invalid")).sampleRate, 0)
  assert.equal(getXiaoCMemoryShadowConfig(enabled(-1)).sampleRate, 0)
  assert.equal(getXiaoCMemoryShadowConfig(enabled(2)).sampleRate, 1)
  assert.equal(getXiaoCMemoryShadowConfig({ ...enabled(1), XIAOC_MEMORY_SHADOW_TIMEOUT_MS: "invalid" }).timeoutMs, 350)
  assert.equal(getXiaoCMemoryShadowConfig({ ...enabled(1), XIAOC_MEMORY_SHADOW_TIMEOUT_MS: "1" }).timeoutMs, 50)
  assert.equal(getXiaoCMemoryShadowConfig({ ...enabled(1), XIAOC_MEMORY_SHADOW_TIMEOUT_MS: "99999" }).timeoutMs, 1500)
})

test("one-percent sampling is deterministic, correlation-only and approximately one percent", () => {
  const selected = Array.from({ length: 10000 }, (_, index) => `request-${index}`)
    .filter(key => isXiaoCMemoryShadowSampled(key, 0.01))
  assert.ok(selected.length >= 75 && selected.length <= 125, selected.length)
  for (const key of ["request-1", "request-99", "request-999"]) {
    assert.equal(isXiaoCMemoryShadowSampled(key, 0.01), isXiaoCMemoryShadowSampled(key, 0.01))
  }
})

test("kill switch and sample zero execute no DB calls and emit no shadow telemetry", async () => {
  for (const env of [{}, enabled(0)]) {
    const repo = repository(); const log = logger()
    const result = await runXiaoCMemoryShadowRead(args({ env, repository: repo, logger: log }))
    assert.equal(result.attempted, false)
    assert.equal(repo.calls.length, 0)
    assert.equal(log.entries.length, 0)
  }
})

test("enabled decisions expose an observable opportunity denominator without private text", async () => {
  const unsampledKey = Array.from({ length: 1000 }, (_, index) => `unsampled-${index}`)
    .find(key => !isXiaoCMemoryShadowSampled(key, 0.01))
  const log = logger(); const repo = repository()
  const result = await runXiaoCMemoryShadowRead(args({ env: enabled(0.01), correlationId: unsampledKey, repository: repo, logger: log }))
  assert.equal(result.eligible_opportunity, true)
  assert.equal(result.sampled, false)
  assert.equal(result.skipped_reason, "NOT_SAMPLED")
  assert.equal(repo.calls.length, 0)
  const serialized = JSON.stringify(log.entries)
  assert.equal(serialized.includes("海岛旅行"), false)
})

test("no-retrieval decisions are observable but never sampled or sent to DB", async () => {
  const repo = repository(); const log = logger()
  const result = await runXiaoCMemoryShadowRead(args({ message: "嗯", repository: repo, logger: log }))
  assert.equal(result.eligible_opportunity, false)
  assert.equal(result.sampled, false)
  assert.equal(result.skipped_reason, "QUERY_PLAN_SKIP")
  assert.equal(repo.calls.length, 0)
})

test("100-percent test sampling remains lexical-only and success telemetry is aggregate-only", async () => {
  const log = logger(); const repo = repository()
  const result = await runXiaoCMemoryShadowRead(args({ repository: repo, logger: log }))
  assert.equal(result.attempted, true)
  assert.equal(result.sampled, true)
  assert.equal(result.degradation_mode, "LEXICAL_ONLY")
  assert.deepEqual(repo.calls, ["lexical"])
  assert.equal(JSON.stringify(log.entries).includes("海岛旅行"), false)
})

test("350ms is one total deadline and late failure creates no unhandled rejection", async () => {
  const unhandled = []
  const listener = reason => unhandled.push(reason)
  process.on("unhandledRejection", listener)
  try {
    const repo = repository({ delay: 400, error: new Error("private database detail") })
    const started = performance.now()
    const result = await runXiaoCMemoryShadowRead(args({ repository: repo }))
    const elapsed = performance.now() - started
    assert.equal(result.error_code, "TIMEOUT")
    assert.ok(elapsed >= 300 && elapsed < 500, elapsed)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(unhandled.length, 0)
  } finally {
    process.off("unhandledRejection", listener)
  }
})

test("DB, malformed, relation and ranking failures use stable privacy-safe codes", () => {
  const cases = [
    ["LEXICAL_RPC_FAILED:private", "DB_ERROR"],
    ["DB_CANDIDATE_CONTENT_INVALID:private", "MALFORMED_RESPONSE"],
    ["RELATION_RPC_FAILED:private", "RELATION_ERROR"],
    ["RANKING_REQUIRES_ELIGIBLE_CANDIDATE:private", "RANKING_ERROR"],
  ]
  for (const [message, code] of cases) assert.equal(classifyXiaoCMemoryShadowError(new Error(message)), code)
})

test("runtime error telemetry never serializes the raw exception", async () => {
  const log = logger()
  const result = await runXiaoCMemoryShadowRead(args({
    repository: repository({ error: new Error("LEXICAL_RPC_FAILED:private database detail") }), logger: log,
  }))
  assert.equal(result.error_code, "DB_ERROR")
  assert.equal(JSON.stringify(log.entries).includes("private database detail"), false)
})

test("QueryPlan adapter failure is caught and reduced to a stable code", async () => {
  const log = logger()
  const result = await runXiaoCMemoryShadowRead(args({ activeItems: { [Symbol.iterator]() { throw new Error("private query-plan detail") } }, logger: log }))
  assert.equal(result.error_code, "QUERYPLAN_ERROR")
  assert.equal(result.attempted, false)
  assert.equal(JSON.stringify(log.entries).includes("private"), false)
})

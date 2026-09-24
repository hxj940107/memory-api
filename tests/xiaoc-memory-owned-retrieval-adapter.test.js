import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import { createMemoryContextBudget } from "../lib/memoryContextGateway.js"
import { retrieveOwnedMemoryPromptCandidatesShadow } from "../lib/xiaocMemoryOwnedRetrievalAdapter.js"
import { runXiaoCMemoryShadowRead } from "../lib/xiaocMemoryShadowRead.js"

const NOW = "2026-09-20T12:00:00.000Z"
const hashFor = id => Buffer.from(String(id)).toString("hex").padEnd(64, "0").slice(0, 64)

function memory(id, content, overrides = {}) {
  return {
    id, user_id: "user", canonical_content: content, content_hash: hashFor(id),
    origin_system: "xiaoc_native", memory_class: "observation", category: "personal_fact",
    provenance_status: "verified_user", lifecycle_status: "active", retrieval_tier: null,
    authority_tier: "native_verified", claim_key: null, importance: 5, confidence: 1,
    event_time: null, valid_from: null, valid_until: null, resolved_at: null, created_at: NOW,
    ...overrides,
  }
}

function repository(rows) {
  const calls = []
  return {
    calls,
    async listLexicalCandidates(args) { calls.push(["lexical", args]); return rows.slice(0, args.limit) },
    async listSemanticCandidates(args) { calls.push(["semantic", args]); throw new Error("semantic must stay disabled") },
    async listRelations(args) { calls.push(["relations", args]); return [] },
  }
}

test("owned adapter is lexical-only and budget-driven without a fixed prompt Top-K", async () => {
  const rows = ["甲", "乙", "丙", "丁"].map((content, index) => memory(`owned-${index + 1}`, content))
  const repo = repository(rows)
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repo, userId: "user", query: "蓝色石头", retrievalTime: NOW,
    context: {}, maxChars: 1000,
  })
  assert.ok(result.promptReadyCandidates.length > 0)
  assert.equal(result.promptReadyCandidates.length, 4)
  assert.equal(result.telemetry.channel_mode, "LEXICAL_ONLY")
  assert.equal(result.telemetry.ranked_pool_count, 4)
  assert.equal(result.telemetry.injected, false)
  assert.equal(repo.calls.some(([name]) => name === "semantic"), false)
  assert.equal(repo.calls[0][1].limit, 24)
})

test("only native verified and explicitly eligible legacy rows become prompt-ready", async () => {
  const rows = [
    memory("active", "她喜欢蓝色石头"),
    memory("archive", "她喜欢蓝色石头", { lifecycle_status: "archived" }),
    memory("deleted", "她喜欢蓝色石头", { lifecycle_status: "deleted" }),
    memory("legacy-approved", "她喜欢蓝色玻璃石头", {
      origin_system: "ombre_legacy", provenance_status: "legacy_unverified",
      authority_tier: "legacy_limited", retrieval_tier: "low_authority",
    }),
    memory("legacy-shadow", "她喜欢蓝色矿石", {
      origin_system: "ombre_legacy", provenance_status: "legacy_unverified",
      authority_tier: "none", retrieval_tier: "shadow_only",
    }),
    memory("irrelevant", "她养过一只小狗"),
  ]
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository(rows), userId: "user", query: "蓝色石头", retrievalTime: NOW,
    context: {}, maxChars: 1000,
  })
  assert.deepEqual(result.promptReadyCandidates.map(item => item.memoryId), ["active", "irrelevant"])
  const legacyOnly = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository(rows.filter(item => item.id.startsWith("legacy"))),
    userId: "user", query: "蓝色玻璃石头", retrievalTime: NOW, context: {}, maxChars: 1000,
  })
  assert.deepEqual(legacyOnly.promptReadyCandidates.map(item => item.memoryId), ["legacy-approved"])
  assert.equal(legacyOnly.promptReadyCandidates[0]?.source, "xiaoc_owned_legacy_limited")
})

test("Core source IDs remain excluded before ranking", async () => {
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository([memory("core", "核心事实"), memory("dynamic", "普通事实")]),
    userId: "user", query: "事实", retrievalTime: NOW, context: {}, maxChars: 1000,
    excludedMemoryIds: ["core"],
  })
  assert.deepEqual(result.promptReadyCandidates.map(item => item.memoryId), ["dynamic"])
  assert.equal(result.telemetry.trace.candidates.some(item => item.memory_id === "core"), false)
})

test("Context Gateway dedupe and shared remaining budget are reused without consuming production budget", async () => {
  const duplicate = "她喜欢蓝色石头"
  const keep = "她收藏蓝色玻璃石头"
  const budget = createMemoryContextBudget(keep.length)
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository([memory("duplicate", duplicate), memory("keep", keep)]),
    userId: "user", query: "蓝色石头", retrievalTime: NOW,
    context: { coreTexts: [duplicate], recentTexts: [], activeTexts: [], summaryTexts: [] },
    memoryBudget: budget,
  })
  assert.deepEqual(result.promptReadyCandidates.map(item => item.memoryId), ["keep"])
  assert.equal(budget.usedChars, 0)
  assert.equal(result.telemetry.used_chars, keep.length)
  assert.equal(result.telemetry.remaining_budget_chars, 0)
  assert.ok(result.diagnostics.some(item => item.suppression_reason === "duplicate_core"))
  assert.ok(result.diagnostics.every(item => item.eligible_for_prompt === false && item.injected === false))
})

test("canonical content stays internal and never enters Shadow telemetry or diagnostics", async () => {
  const secret = "她喜欢蓝色石头"
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository([memory("private", secret)]), userId: "user", query: "蓝色石头",
    retrievalTime: NOW, context: {}, maxChars: 1000,
  })
  assert.equal(result.promptReadyCandidates[0].content, secret)
  assert.doesNotMatch(JSON.stringify(result.telemetry), new RegExp(secret))
  assert.doesNotMatch(JSON.stringify(result.diagnostics), new RegExp(secret))
})

test("eligible semantic-only candidates reach ranking without an absolute admission gate", async () => {
  const privateContent = "她有一个需要长期记住的私人事实"
  const row = memory("semantic-private", privateContent)
  const repo = {
    async listLexicalCandidates() { return [] },
    async listSemanticCandidates() {
      return [{
        ...row,
        semantic_similarity: 0.71,
        rollout_status: "active",
        provider: "openrouter",
        model: "openai/text-embedding-3-small",
        embedding_version: "v1",
        preprocessor_version: "canonical-content-v1",
        dimensions: 1536,
      }]
    },
    async listRelations() { return [] },
  }
  const embeddingProvider = {
    async embed() { return [Array(1536).fill(0).map((_, index) => index === 0 ? 1 : 0)] },
  }
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repo,
    embeddingProvider,
    env: { XIAOC_MEMORY_SEMANTIC_RETRIEVAL_ENABLED: "true" },
    userId: "user",
    query: "完全不同的问法",
    retrievalTime: NOW,
    context: {},
    maxChars: 1000,
  })
  assert.equal(result.telemetry.trace.candidates[0].memory_id, "semantic-private")
  assert.equal(result.telemetry.trace.candidates[0].lexical_score, 0)
  assert.equal(result.telemetry.trace.candidates[0].semantic_score, 0.71)
  assert.equal(result.telemetry.trace.candidates[0].stage, "ranked")
  assert.doesNotMatch(JSON.stringify(result.telemetry), new RegExp(privateContent))
})

test("Phase 3 Shadow wiring remains non-injecting beside the explicit authoritative path", () => {
  const chat = fs.readFileSync("api/chat.js", "utf8")
  const shadow = fs.readFileSync("lib/xiaocMemoryShadowRead.js", "utf8")
  assert.match(chat, /ownedOnly: ownedFreshEmpty/)
  assert.match(chat, /waitUntil\(runXiaoCMemoryShadowRead/)
  assert.match(chat, /else if \(ownedAuthoritative\)[\s\S]*shadowOnly: false/)
  assert.match(shadow, /prompt_readiness: taskResult\.ownedPromptReadiness/)
  assert.doesNotMatch(shadow, /promptReadyCandidates[\s\S]*logger/)
  assert.match(chat, /if \(!ownedAuthoritative\) waitUntil\(runXiaoCMemoryShadowRead/)
})

test("owned runtime emits aggregate prompt-readiness only and no canonical content", async () => {
  const secret = "她喜欢蓝色石头"
  const logEntries = []
  const result = await runXiaoCMemoryShadowRead({
    env: {
      XIAOC_MEMORY_SHADOW_READ_ENABLED: "true",
      XIAOC_MEMORY_SHADOW_SAMPLE_RATE: "1",
      XIAOC_MEMORY_SHADOW_TIMEOUT_MS: "200",
    },
    repository: repository([memory("runtime", secret)]),
    trustedUserId: "user", requestedUserId: "user", message: "蓝色石头",
    correlationId: "owned-runtime", now: () => NOW, ownedOnly: true,
    promptContext: {}, memoryBudget: createMemoryContextBudget(1000),
    logger: { log(label, value) { logEntries.push([label, value]) }, warn(label, value) { logEntries.push([label, value]) } },
  })
  assert.equal(result.prompt_readiness.prompt_ready_count, 1)
  assert.equal(result.prompt_readiness.injected, false)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
  assert.doesNotMatch(JSON.stringify(logEntries), new RegExp(secret))
})

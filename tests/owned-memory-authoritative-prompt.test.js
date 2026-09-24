import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import { createMemoryContextBudget } from "../lib/memoryContextGateway.js"
import {
  MEMORY_AUTHORITY_MODE,
  assertOmbreAuthority,
  getMemoryAuthorityMode,
  isOwnedAuthoritativeMode,
  isOwnedMemoryAuthorityMode,
} from "../lib/memoryAuthority.js"
import { ensureCoreMemorySnapshot } from "../lib/coreMemorySnapshot.js"
import { retrieveOwnedMemoryPromptCandidatesShadow } from "../lib/xiaocMemoryOwnedRetrievalAdapter.js"
import { XIAOC_MEMORY_EMBEDDING_IDENTITY } from "../lib/aiConfig.js"

const NOW = "2026-09-20T12:00:00.000Z"

function memory(id, content, overrides = {}) {
  return {
    id, user_id: "user", canonical_content: content,
    content_hash: Buffer.from(id).toString("hex").padEnd(64, "0").slice(0, 64),
    origin_system: "xiaoc_native", memory_class: "observation", category: "personal_fact",
    provenance_status: "verified_user", lifecycle_status: "active", retrieval_tier: null,
    authority_tier: "native_verified", claim_key: null, importance: null, confidence: null,
    event_time: null, valid_from: null, valid_until: null, resolved_at: null, created_at: NOW,
    ...overrides,
  }
}

function repository(rows) {
  const calls = []
  return {
    calls,
    async listLexicalCandidates(args) { calls.push(["lexical", args]); return rows.slice(0, args.limit) },
    async listSemanticCandidates() { throw new Error("semantic must remain disabled") },
    async listRelations(args) { calls.push(["relations", args]); return [] },
  }
}

test("owned_authoritative initializes Owned Core and remains Ombre-fail-closed", async () => {
  assert.equal(
    getMemoryAuthorityMode({ XIAOC_MEMORY_AUTHORITY_MODE: "owned_authoritative" }),
    MEMORY_AUTHORITY_MODE.OWNED_AUTHORITATIVE,
  )
  assert.equal(isOwnedAuthoritativeMode(MEMORY_AUTHORITY_MODE.OWNED_AUTHORITATIVE), true)
  assert.equal(isOwnedMemoryAuthorityMode(MEMORY_AUTHORITY_MODE.OWNED_AUTHORITATIVE), true)
  assert.throws(() => assertOmbreAuthority(MEMORY_AUTHORITY_MODE.OWNED_AUTHORITATIVE), {
    code: "OMBRE_NOT_APPLICABLE",
  })
  const core = await ensureCoreMemorySnapshot({
    conversationId: "owned-authoritative",
    authorityMode: MEMORY_AUTHORITY_MODE.OWNED_AUTHORITATIVE,
    readSnapshot: async () => null,
    initializeSnapshot: async () => assert.fail("owned Core must not use Ombre snapshot persistence"),
    initializeOwnedSnapshot: async () => ({
      owned_core_memory_snapshot: "Owned Core body",
      owned_core_memory_snapshot_hash: "f439b72beff6de91924d31a95b70f9b5619e35f9aabebf5c6c9f4c0d38a8bb3f",
      owned_core_memory_snapshot_created_at: NOW,
      owned_core_memory_sources: [{ memory_id: "10000000-0000-4000-8000-000000000001", content_hash: "a".repeat(64) }],
    }),
    fetchPinnedMemories: async () => assert.fail("owned Core must not call Ombre"),
  })
  assert.equal(core.snapshot, "Owned Core body")
  assert.equal(core.authorityMode, MEMORY_AUTHORITY_MODE.OWNED_AUTHORITATIVE)
})

test("owned_authoritative ignores a persisted Ombre Core snapshot without using it as authority", async () => {
  let legacyInitialized = false
  let ownedInitialized = false
  let fetched = false
  const core = await ensureCoreMemorySnapshot({
    conversationId: "legacy-core-conversation",
    authorityMode: MEMORY_AUTHORITY_MODE.OWNED_AUTHORITATIVE,
    readSnapshot: async () => ({
      core_memory_snapshot: "historical Ombre Core body",
      core_memory_snapshot_hash: "not-consulted",
      core_memory_snapshot_created_at: NOW,
      core_memory_source_bucket_ids: ["legacy-bucket"],
    }),
    initializeSnapshot: async () => { legacyInitialized = true },
    initializeOwnedSnapshot: async () => {
      ownedInitialized = true
      return {
        owned_core_memory_snapshot: "Owned replacement Core",
        owned_core_memory_snapshot_hash: "72c9fcaea6a2c6e7a727299db433be55457b9bde0efbe265dd34cf815e288ddb",
        owned_core_memory_snapshot_created_at: NOW,
        owned_core_memory_sources: [{ memory_id: "10000000-0000-4000-8000-000000000002", content_hash: "b".repeat(64) }],
      }
    },
    fetchPinnedMemories: async () => { fetched = true },
  })
  assert.equal(core.snapshot, "Owned replacement Core")
  assert.deepEqual(core.sourceMemoryIds, ["10000000-0000-4000-8000-000000000002"])
  assert.equal(core.authorityMode, MEMORY_AUTHORITY_MODE.OWNED_AUTHORITATIVE)
  assert.equal(legacyInitialized, false)
  assert.equal(ownedInitialized, true)
  assert.equal(fetched, false)
})

test("authoritative adapter injects only active native verified candidates and consumes shared budget", async () => {
  const selected = "她最喜欢蓝色石头"
  const budget = createMemoryContextBudget(selected.length)
  const repo = repository([
    memory("active", selected),
    memory("archived", selected, { lifecycle_status: "archived" }),
    memory("legacy", selected, { origin_system: "ombre_legacy", authority_tier: "legacy_limited", provenance_status: "legacy_unverified" }),
  ])
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repo,
    userId: "user",
    query: "蓝色石头",
    retrievalTime: NOW,
    context: {},
    memoryBudget: budget,
    shadowOnly: false,
  })
  assert.deepEqual(result.promptReadyCandidates.map(item => item.memoryId), ["active"])
  assert.equal(budget.remainingChars, 0)
  assert.equal(result.telemetry.injected, true)
  assert.equal(result.telemetry.channel_mode, "LEXICAL_ONLY")
  assert.equal(result.promptReadyCandidates.length, 1)
  assert.equal(repo.calls.some(([name]) => name === "semantic"), false)
  assert.ok(result.diagnostics.some(item => item.candidate_id === "xiaoc-owned-active" && item.injected === true))
})

test("semantic flag enables hybrid retrieval and merges a semantic hit", async () => {
  const item = memory("semantic-hit", "她珍惜那次海边旅行")
  const repo = {
    async listLexicalCandidates() { return [] },
    async listSemanticCandidates() { return [{ memory: item, semantic_similarity: 0.95, rollout_status: "active", provider: XIAOC_MEMORY_EMBEDDING_IDENTITY.providerId, model: XIAOC_MEMORY_EMBEDDING_IDENTITY.modelId, embedding_version: XIAOC_MEMORY_EMBEDDING_IDENTITY.version, preprocessor_version: XIAOC_MEMORY_EMBEDDING_IDENTITY.preprocessorVersion, dimensions: XIAOC_MEMORY_EMBEDDING_IDENTITY.dimension }] },
    async listRelations() { return [] },
  }
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({ repository: repo, userId: "user", query: "还记得那次旅行吗", retrievalTime: NOW,
    context: {}, memoryBudget: createMemoryContextBudget(1000), shadowOnly: false,
    env: { XIAOC_MEMORY_SEMANTIC_RETRIEVAL_ENABLED: "true" },
    embeddingProvider: { embed: async () => [Array(XIAOC_MEMORY_EMBEDDING_IDENTITY.dimension).fill(0.01)] },
  })
  assert.equal(result.telemetry.requested_channel_mode, "HYBRID")
  assert.equal(result.telemetry.channel_mode, "HYBRID")
  assert.equal(result.promptReadyCandidates[0]?.memoryId, "semantic-hit")
  assert.deepEqual(result.telemetry.trace.candidates.map(item => ({
    memory_id: item.memory_id,
    lexical_score: item.lexical_score,
    semantic_score: item.semantic_score,
    final_score: item.final_score,
    stage: item.stage,
  })), [{
    memory_id: "semantic-hit",
    lexical_score: 0.771111,
    semantic_score: 0.95,
    final_score: 0.83414,
    stage: "ranked",
  }])
  assert.equal(JSON.stringify(result.telemetry).includes(item.canonical_content), false)
})

test("authoritative Context Gateway suppresses duplicates and backfills the next ranked memory", async () => {
  const duplicate = "她最喜欢蓝色石头"
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository([
      memory("duplicate", duplicate),
      memory("irrelevant", "她曾经去过冰岛"),
    ]),
    userId: "user",
    query: "蓝色石头",
    retrievalTime: NOW,
    context: { recentTexts: [duplicate] },
    memoryBudget: createMemoryContextBudget(500),
    shadowOnly: false,
  })
  assert.deepEqual(result.promptReadyCandidates.map(item => item.memoryId), ["irrelevant"])
  assert.equal(result.telemetry.injected, true)
  assert.ok(result.diagnostics.some(item => item.suppression_reason === "duplicate_recent"))
  assert.ok(result.telemetry.trace.gateway.some(item => item.memory_id === "duplicate" && item.suppression_reason === "duplicate_recent"))
})

test("authoritative Gateway uses an exact complete sentence when selected Memory exceeds budget", async () => {
  const coreFact = "她的名字是小天使。"
  const longRepresentation = `${coreFact}${"这是补充背景。".repeat(60)}`
  const budget = createMemoryContextBudget(coreFact.length)
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository([memory("long-selected", longRepresentation)]),
    userId: "user",
    query: "名字小天使",
    retrievalTime: NOW,
    context: {},
    memoryBudget: budget,
    shadowOnly: false,
  })
  assert.equal(result.promptReadyCandidates[0]?.content, coreFact)
  assert.equal(result.diagnostics[0]?.representation_compacted, true)
  assert.equal(budget.usedChars, coreFact.length)
  assert.ok(budget.usedChars <= budget.maxChars)
})

test("authoritative Gateway leaves fitting representations unchanged and stays inside the char budget", async () => {
  const row = memory("fit", "她喜欢蓝色石头。")
  const budget = createMemoryContextBudget(row.canonical_content.length)
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository([row]), userId: "user", query: "蓝色石头",
    retrievalTime: NOW, context: {}, memoryBudget: budget, shadowOnly: false,
  })
  assert.equal(result.promptReadyCandidates.length, 1)
  assert.equal(result.promptReadyCandidates[0].content, row.canonical_content)
  assert.ok(result.diagnostics.filter(item => item.injected).every(item => item.representation_compacted === false))
  assert.ok(budget.usedChars <= budget.maxChars)
})

test("approved historical memories are budget-driven while forbidden legacy tiers stay excluded", async () => {
  const rows = [
    memory("legacy-a", "她喜欢蓝色石头", { origin_system: "ombre_legacy", provenance_status: "legacy_unverified", authority_tier: "legacy_limited", retrieval_tier: "low_authority" }),
    memory("legacy-b", "她珍惜海边旅行", { origin_system: "ombre_legacy", provenance_status: "legacy_unverified", authority_tier: "legacy_limited", retrieval_tier: "low_authority" }),
    memory("legacy-c", "她保存小C纪念礼物", { origin_system: "ombre_legacy", provenance_status: "legacy_unverified", authority_tier: "legacy_limited", retrieval_tier: "low_authority" }),
    memory("legacy-shadow", "她研究蓝色石头", { origin_system: "ombre_legacy", provenance_status: "legacy_unverified", authority_tier: "none", retrieval_tier: "shadow_only" }),
    memory("legacy-disabled", "她见过蓝色石头", { origin_system: "ombre_legacy", provenance_status: "legacy_unverified", authority_tier: "none", retrieval_tier: "disabled" }),
  ]
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: {
      async listLexicalCandidates() { return [] },
      async listSemanticCandidates() {
        return rows.map(row => ({
          ...row, semantic_similarity: 0.9, rollout_status: "active",
          provider: XIAOC_MEMORY_EMBEDDING_IDENTITY.providerId,
          model: XIAOC_MEMORY_EMBEDDING_IDENTITY.modelId,
          embedding_version: XIAOC_MEMORY_EMBEDDING_IDENTITY.version,
          preprocessor_version: XIAOC_MEMORY_EMBEDDING_IDENTITY.preprocessorVersion,
          dimensions: XIAOC_MEMORY_EMBEDDING_IDENTITY.dimension,
        }))
      },
      async listRelations() { return [] },
    },
    embeddingProvider: { embed: async () => [Array(XIAOC_MEMORY_EMBEDDING_IDENTITY.dimension).fill(0.01)] },
    env: { XIAOC_MEMORY_SEMANTIC_RETRIEVAL_ENABLED: "true" },
    userId: "user", query: "相关的长期记忆", retrievalTime: NOW,
    context: {}, memoryBudget: createMemoryContextBudget(1000), shadowOnly: false,
  })
  assert.equal(result.promptReadyCandidates.length, 3)
  assert.equal(result.promptReadyCandidates.every(item => item.memoryId.startsWith("legacy-")), true)
  assert.equal(result.promptReadyCandidates.every(item => item.source === "xiaoc_owned_legacy_limited"), true)
})

test("Gateway suppression backfills prompt-ready slots from the ranked pool", async () => {
  const first = "她喜欢蓝色石头"
  const second = "她收藏蓝色玻璃石头"
  const third = "她珍惜蓝色纪念石头"
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository([memory("first", first), memory("second", second), memory("third", third)]),
    userId: "user", query: "蓝色石头", retrievalTime: NOW,
    context: { summaryTexts: [first], recentTexts: [second] },
    memoryBudget: createMemoryContextBudget(1000), shadowOnly: false,
  })
  assert.deepEqual(result.promptReadyCandidates.map(item => item.memoryId), ["third"])
  assert.equal(result.diagnostics.find(item => item.memory_id === "first")?.suppression_reason, "duplicate_summary")
  assert.equal(result.diagnostics.find(item => item.memory_id === "second")?.suppression_reason, "duplicate_recent")
})

test("Gateway refill is not capped at three and never exceeds the shared character budget", async () => {
  const duplicate = "她喜欢蓝色石头"
  const rows = [
    memory("duplicate", duplicate),
    memory("one", "甲"),
    memory("two", "乙"),
    memory("three", "丙"),
    memory("four", "丁"),
  ]
  const acceptedChars = rows.slice(1).reduce((sum, row) => sum + row.canonical_content.length, 0)
  const budget = createMemoryContextBudget(acceptedChars)
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository(rows), userId: "user", query: "蓝色石头", retrievalTime: NOW,
    context: { summaryTexts: [duplicate] }, memoryBudget: budget, shadowOnly: false,
  })
  assert.equal(result.promptReadyCandidates.length, 4)
  assert.ok(budget.usedChars <= budget.maxChars)
  assert.equal(result.promptReadyCandidates.some(item => item.memoryId === "duplicate"), false)
})

test("Gateway skips an unsafe partial representation and backfills a later short Memory", async () => {
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository([
      memory("long", "这是一条没有任何完整句号而且远远超过剩余预算的长期记忆正文"),
      memory("short", "短记忆。"),
    ]),
    userId: "user", query: "任意", retrievalTime: NOW,
    context: {}, memoryBudget: createMemoryContextBudget("短记忆。".length), shadowOnly: false,
  })
  assert.deepEqual(result.promptReadyCandidates.map(item => item.memoryId), ["short"])
  assert.equal(result.promptReadyCandidates[0].content, "短记忆。")
  assert.equal(result.diagnostics.find(item => item.memory_id === "long")?.suppression_reason, "budget_exceeded")
})

test("owned prompt injection strictly respects the unchanged 380 character budget", async () => {
  const rows = Array.from({ length: 8 }, (_, index) => memory(`budget-${index}`, `${String(index).repeat(70)}。`))
  const budget = createMemoryContextBudget(380)
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository(rows), userId: "user", query: "任意", retrievalTime: NOW,
    context: {}, memoryBudget: budget, shadowOnly: false,
  })
  assert.ok(result.promptReadyCandidates.length > 3)
  assert.ok(result.telemetry.used_chars <= 380)
  assert.ok(budget.usedChars <= 380)
  assert.equal(result.telemetry.remaining_budget_chars, 380 - result.telemetry.used_chars)
  assert.ok(result.promptReadyCandidates.every(item => item.content.endsWith("。")))
})

test("chat wiring keeps both existing modes intact and owned authority non-proactive", () => {
  const chat = fs.readFileSync("api/chat.js", "utf8")
  const memoryApi = fs.readFileSync("api/memory.js", "utf8")
  assert.match(chat, /memoryAuthorityMode === MEMORY_AUTHORITY_MODE\.OMBRE_AUTHORITATIVE[\s\S]*getMemorySmart/)
  assert.match(chat, /else if \(ownedAuthoritative\)[\s\S]*shadowOnly: false/)
  assert.match(chat, /dynamicMemory = ownedMemoryResult\.promptReadyCandidates\.map\(item => item\.content\)/)
  assert.match(chat, /candidates: ownedAuthoritative \? \[\] : await getStableMemories\(user_id\)/)
  assert.match(chat, /if \(!ownedAuthoritative\) waitUntil\(runXiaoCMemoryShadowRead/)
  assert.match(chat, /console\.log\("OWNED MEMORY RETRIEVAL:", JSON\.stringify\(ownedMemoryResult\.telemetry\)\)/)
  assert.match(chat, /if \(memoryAuthorityMode === MEMORY_AUTHORITY_MODE\.OMBRE_AUTHORITATIVE\)[\s\S]*saveLongTermMemory/)
  assert.doesNotMatch(chat, /ownedMemoryResult[\s\S]{0,200}proactiveAttention/)
  assert.match(memoryApi, /const ownedMemoryAuthority = isOwnedMemoryAuthorityMode\(memoryAuthorityMode\)/)
  assert.match(memoryApi, /if \(ownedMemoryAuthority\) \{[\s\S]*mutateOwnedMemories/)
  assert.match(memoryApi, /if \(ownedMemoryAuthority\) \{[\s\S]*listOwnedMemoryLibrary/)
})

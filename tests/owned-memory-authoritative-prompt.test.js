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

test("owned_authoritative is explicit, Core-empty, and Ombre-fail-closed", async () => {
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
    initializeSnapshot: async () => assert.fail("owned Core must not persist"),
    fetchPinnedMemories: async () => assert.fail("owned Core must not call Ombre"),
  })
  assert.equal(core.snapshot, "")
  assert.equal(core.authorityMode, MEMORY_AUTHORITY_MODE.OWNED_AUTHORITATIVE)
})

test("owned_authoritative ignores a persisted Ombre Core snapshot without using it as authority", async () => {
  let initialized = false
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
    initializeSnapshot: async () => { initialized = true },
    fetchPinnedMemories: async () => { fetched = true },
  })
  assert.equal(core.snapshot, "")
  assert.deepEqual(core.sourceBucketIds, [])
  assert.equal(core.authorityMode, MEMORY_AUTHORITY_MODE.OWNED_AUTHORITATIVE)
  assert.equal(initialized, false)
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
  assert.ok(result.promptReadyCandidates.length <= 3)
  assert.equal(repo.calls.some(([name]) => name === "semantic"), false)
  assert.ok(result.diagnostics.some(item => item.candidate_id === "xiaoc-owned-active" && item.injected === true))
})

test("authoritative Context Gateway suppresses duplicates and unrelated memories", async () => {
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
  assert.deepEqual(result.promptReadyCandidates, [])
  assert.equal(result.telemetry.injected, false)
  assert.ok(result.diagnostics.some(item => item.suppression_reason === "duplicate_recent"))
})

test("approved legacy is bounded to one slot and forbidden legacy tiers stay excluded", async () => {
  const rows = [
    memory("legacy-a", "她喜欢蓝色石头", { origin_system: "ombre_legacy", provenance_status: "legacy_unverified", authority_tier: "legacy_limited", retrieval_tier: "low_authority" }),
    memory("legacy-b", "她收藏蓝色石头", { origin_system: "ombre_legacy", provenance_status: "legacy_unverified", authority_tier: "legacy_limited", retrieval_tier: "low_authority" }),
    memory("legacy-shadow", "她研究蓝色石头", { origin_system: "ombre_legacy", provenance_status: "legacy_unverified", authority_tier: "none", retrieval_tier: "shadow_only" }),
    memory("legacy-disabled", "她见过蓝色石头", { origin_system: "ombre_legacy", provenance_status: "legacy_unverified", authority_tier: "none", retrieval_tier: "disabled" }),
  ]
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository(rows), userId: "user", query: "蓝色石头", retrievalTime: NOW,
    context: {}, memoryBudget: createMemoryContextBudget(1000), shadowOnly: false,
  })
  assert.equal(result.promptReadyCandidates.length, 1)
  assert.match(result.promptReadyCandidates[0].memoryId, /^legacy-[ab]$/)
  assert.equal(result.promptReadyCandidates[0].source, "xiaoc_owned_legacy_limited")
})

test("chat wiring keeps both existing modes intact and owned authority non-proactive", () => {
  const chat = fs.readFileSync("api/chat.js", "utf8")
  const memoryApi = fs.readFileSync("api/memory.js", "utf8")
  assert.match(chat, /memoryAuthorityMode === MEMORY_AUTHORITY_MODE\.OMBRE_AUTHORITATIVE[\s\S]*getMemorySmart/)
  assert.match(chat, /else if \(ownedAuthoritative\)[\s\S]*shadowOnly: false/)
  assert.match(chat, /dynamicMemory = ownedMemoryResult\.promptReadyCandidates\.map\(item => item\.content\)/)
  assert.match(chat, /candidates: ownedAuthoritative \? \[\] : await getStableMemories\(user_id\)/)
  assert.match(chat, /if \(!ownedAuthoritative\) waitUntil\(runXiaoCMemoryShadowRead/)
  assert.match(chat, /if \(memoryAuthorityMode === MEMORY_AUTHORITY_MODE\.OMBRE_AUTHORITATIVE\)[\s\S]*saveLongTermMemory/)
  assert.doesNotMatch(chat, /ownedMemoryResult[\s\S]{0,200}proactiveAttention/)
  assert.match(memoryApi, /const ownedMemoryAuthority = isOwnedMemoryAuthorityMode\(memoryAuthorityMode\)/)
  assert.match(memoryApi, /if \(ownedMemoryAuthority\) \{[\s\S]*mutateOwnedMemories/)
  assert.match(memoryApi, /if \(ownedMemoryAuthority\) \{[\s\S]*listOwnedMemoryLibrary/)
})

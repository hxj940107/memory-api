import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import { createMemoryContextBudget } from "../lib/memoryContextGateway.js"
import {
  XIAOC_OWNED_MEMORY_PROMPT_READY_TOP_K,
  retrieveOwnedMemoryPromptCandidatesShadow,
} from "../lib/xiaocMemoryOwnedRetrievalAdapter.js"
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

test("owned adapter is lexical-only, normal-current, thresholded, and Top-K <= 3", async () => {
  const rows = [1, 2, 3, 4].map(index => memory(`owned-${index}`, `她喜欢蓝色石头 ${index}`))
  const repo = repository(rows)
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repo, userId: "user", query: "蓝色石头", retrievalTime: NOW,
    context: {}, maxChars: 1000,
  })
  assert.ok(result.promptReadyCandidates.length > 0)
  assert.ok(result.promptReadyCandidates.length <= XIAOC_OWNED_MEMORY_PROMPT_READY_TOP_K)
  assert.equal(result.telemetry.channel_mode, "LEXICAL_ONLY")
  assert.equal(result.telemetry.top_k, 3)
  assert.equal(result.telemetry.injected, false)
  assert.equal(repo.calls.some(([name]) => name === "semantic"), false)
  assert.equal(repo.calls[0][1].limit, 24)
})

test("non-owned, archived, deleted, and irrelevant rows never become prompt-ready", async () => {
  const rows = [
    memory("active", "她喜欢蓝色石头"),
    memory("archive", "她喜欢蓝色石头", { lifecycle_status: "archived" }),
    memory("deleted", "她喜欢蓝色石头", { lifecycle_status: "deleted" }),
    memory("legacy", "她喜欢蓝色石头", {
      origin_system: "ombre_legacy", provenance_status: "legacy_unverified",
      authority_tier: "legacy_limited", retrieval_tier: "low_authority",
    }),
    memory("irrelevant", "她养过一只小狗"),
  ]
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository: repository(rows), userId: "user", query: "蓝色石头", retrievalTime: NOW,
    context: {}, maxChars: 1000,
  })
  assert.deepEqual(result.promptReadyCandidates.map(item => item.memoryId), ["active"])
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

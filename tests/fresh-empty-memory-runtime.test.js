import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  MEMORY_AUTHORITY_MODE,
  assertOmbreAuthority,
  getMemoryAuthorityMode,
  isOwnedFreshEmptyMode,
} from "../lib/memoryAuthority.js"
import {
  buildFreshEmptyCoreMemoryState,
  ensureCoreMemorySnapshot,
  hashCoreMemorySnapshot,
} from "../lib/coreMemorySnapshot.js"
import { runXiaoCMemoryNativeCapture } from "../lib/xiaocMemoryNativeCapture.js"
import { runXiaoCMemoryShadowRead } from "../lib/xiaocMemoryShadowRead.js"

test("memory authority mode is explicit, backwards compatible, and fail closed", () => {
  assert.equal(getMemoryAuthorityMode({}), MEMORY_AUTHORITY_MODE.OMBRE_AUTHORITATIVE)
  assert.equal(getMemoryAuthorityMode({ XIAOC_MEMORY_AUTHORITY_MODE: "" }), MEMORY_AUTHORITY_MODE.OMBRE_AUTHORITATIVE)
  assert.equal(getMemoryAuthorityMode({ XIAOC_MEMORY_AUTHORITY_MODE: "ombre_authoritative" }), MEMORY_AUTHORITY_MODE.OMBRE_AUTHORITATIVE)
  assert.equal(getMemoryAuthorityMode({ XIAOC_MEMORY_AUTHORITY_MODE: "owned_fresh_empty" }), MEMORY_AUTHORITY_MODE.OWNED_FRESH_EMPTY)
  assert.equal(isOwnedFreshEmptyMode(MEMORY_AUTHORITY_MODE.OWNED_FRESH_EMPTY), true)
  assert.throws(() => getMemoryAuthorityMode({ XIAOC_MEMORY_AUTHORITY_MODE: "automatic" }), {
    code: "INVALID_MEMORY_AUTHORITY_MODE",
  })
})

test("fresh-empty Core state is deterministic, non-persisted, and performs zero Ombre calls", async () => {
  let fetchCount = 0
  let initializeCount = 0
  const result = await ensureCoreMemorySnapshot({
    conversationId: "fresh-conversation",
    authorityMode: MEMORY_AUTHORITY_MODE.OWNED_FRESH_EMPTY,
    readSnapshot: async () => null,
    initializeSnapshot: async () => { initializeCount += 1; throw new Error("must not initialize") },
    fetchPinnedMemories: async () => { fetchCount += 1; throw new Error("must not fetch Ombre") },
  })

  assert.deepEqual(result, buildFreshEmptyCoreMemoryState())
  assert.equal(result.snapshot, "")
  assert.equal(result.hash, hashCoreMemorySnapshot(""))
  assert.deepEqual(result.sourceBucketIds, [])
  assert.equal(result.createdAt, null)
  assert.equal(result.authorityMode, "owned_fresh_empty")
  assert.equal(result.empty, true)
  assert.equal(fetchCount, 0)
  assert.equal(initializeCount, 0)
})

test("fresh-empty mode rejects an unexpected historical Core snapshot", async () => {
  await assert.rejects(ensureCoreMemorySnapshot({
    conversationId: "conflicting-conversation",
    authorityMode: MEMORY_AUTHORITY_MODE.OWNED_FRESH_EMPTY,
    readSnapshot: async () => ({
      core_memory_snapshot: "historical memory",
      core_memory_snapshot_hash: hashCoreMemorySnapshot("historical memory"),
      core_memory_snapshot_created_at: "2026-09-19T00:00:00.000Z",
      core_memory_source_bucket_ids: ["legacy-bucket"],
    }),
    initializeSnapshot: async () => assert.fail("must not initialize"),
    fetchPinnedMemories: async () => assert.fail("must not fetch Ombre"),
  }), { code: "FRESH_EMPTY_CORE_SNAPSHOT_CONFLICT" })
})

test("default Ombre mode keeps fetch, initialization, and failure semantics", async () => {
  let fetchCount = 0
  let initializeCount = 0
  const memory = { id: "pin-1", content: "完整核心记忆" }
  const result = await ensureCoreMemorySnapshot({
    conversationId: "ombre-conversation",
    readSnapshot: async () => null,
    fetchPinnedMemories: async () => { fetchCount += 1; return [memory] },
    initializeSnapshot: async candidate => {
      initializeCount += 1
      return {
        core_memory_snapshot: candidate.snapshot,
        core_memory_snapshot_hash: candidate.hash,
        core_memory_snapshot_created_at: candidate.createdAt,
        core_memory_source_bucket_ids: candidate.sourceBucketIds,
      }
    },
  })
  assert.equal(result.snapshot, memory.content)
  assert.equal(fetchCount, 1)
  assert.equal(initializeCount, 1)

  for (const message of ["credential missing", "network failed", "auth failed"]) {
    await assert.rejects(ensureCoreMemorySnapshot({
      conversationId: message,
      readSnapshot: async () => null,
      initializeSnapshot: async () => assert.fail("must not initialize after Ombre failure"),
      fetchPinnedMemories: async () => { throw new Error(message) },
    }), new RegExp(message))
  }
  await assert.rejects(ensureCoreMemorySnapshot({
    conversationId: "empty-pins",
    readSnapshot: async () => null,
    initializeSnapshot: async () => assert.fail("must not initialize empty pins"),
    fetchPinnedMemories: async () => [],
  }), /no complete pinned memories/i)
})

test("fresh mode cannot use guarded Ombre endpoints even if credentials or URL exist", () => {
  assert.throws(() => assertOmbreAuthority(MEMORY_AUTHORITY_MODE.OWNED_FRESH_EMPTY), {
    code: "OMBRE_NOT_APPLICABLE",
  })
  assert.doesNotThrow(() => assertOmbreAuthority(MEMORY_AUTHORITY_MODE.OMBRE_AUTHORITATIVE))
})

test("chat and Memory API isolate every Ombre surface while preserving non-injecting Shadow", () => {
  const chat = fs.readFileSync("api/chat.js", "utf8")
  const memory = fs.readFileSync("api/memory.js", "utf8")

  assert.match(chat, /const ownedFreshEmpty = isOwnedFreshEmptyMode\(memoryAuthorityMode\)/)
  assert.match(chat, /if \(!ownedFreshEmpty\) \{[\s\S]*getDynamicMemoryExclusions[\s\S]*getMemorySmart/)
  assert.match(chat, /if \(!ownedFreshEmpty\) \{[\s\S]*saveLongTermMemory/)
  assert.match(chat, /waitUntil\(runXiaoCMemoryShadowRead\(/)
  assert.doesNotMatch(chat, /dynamicMemory\s*=\s*(?:owned|xiaoc)/i)

  assert.match(memory, /assertOmbreAuthority\(getMemoryAuthorityMode\(process\.env\)\)/)
  assert.match(memory, /owned-fresh-empty/)
  assert.match(memory, /code:\s*"OMBRE_NOT_APPLICABLE"/)
})

test("owned corpus can grow from zero through existing gates and remains Shadow-only", async () => {
  const rows = []
  const messageId = "10000000-0000-4000-8000-000000000001"
  const client = {
    async rpc(name) {
      assert.equal(name, "xiaoc_memory_capture_verified")
      rows.push({
        id: "20000000-0000-4000-8000-000000000002",
        user_id: "user",
        canonical_content: "她去过冰岛看极光",
        content_hash: "c14194de84adbe0a30d1a3d7aa1fc809890fac889d1cc7fae3bc32a13a2361cf",
        origin_system: "xiaoc_native",
        memory_class: "observation",
        category: "meaningful_experience",
        provenance_status: "verified_user",
        lifecycle_status: "active",
        retrieval_tier: null,
        authority_tier: "native_verified",
        claim_key: null,
        importance: 5,
        confidence: 1,
        event_time: null,
        valid_from: null,
        valid_until: null,
        resolved_at: null,
        created_at: "2026-09-19T00:00:00.000Z",
        lexical_score: 1,
      })
      return { data: rows[0].id, error: null }
    },
  }
  const repository = {
    async listLexicalCandidates() { return rows },
    async listSemanticCandidates() { return [] },
    async listRelations() { return [] },
  }
  const shadowEnv = {
    XIAOC_MEMORY_SHADOW_READ_ENABLED: "true",
    XIAOC_MEMORY_SHADOW_SAMPLE_RATE: "1",
    XIAOC_MEMORY_SHADOW_TIMEOUT_MS: "200",
  }
  const before = await runXiaoCMemoryShadowRead({
    env: shadowEnv, repository, trustedUserId: "user", requestedUserId: "user",
    message: "冰岛极光", correlationId: "before", logger: { log() {}, warn() {} },
  })
  assert.equal(before.xiaoc.selected_count, 0)

  const capture = await runXiaoCMemoryNativeCapture({
    client,
    env: { XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED: "true" },
    trustedUserId: "user",
    requestedUserId: "user",
    currentMessageId: messageId,
    sourceMessageId: messageId,
    currentConversationId: "conversation-1",
    sourceConversationId: "conversation-1",
    currentMessage: "我去过冰岛看极光",
    judgeResult: {
      save: true,
      category: "meaningful_experience",
      content: "她去过冰岛看极光",
      provenance: {
        source_role: "user",
        source_message_id: messageId,
        evidence_text: "我去过冰岛看极光",
        evidence_type: "assertion",
      },
    },
  })
  assert.equal(capture.outcome, "success")
  assert.equal(rows.length, 1)

  const after = await runXiaoCMemoryShadowRead({
    env: shadowEnv, repository, trustedUserId: "user", requestedUserId: "user",
    message: "冰岛极光", correlationId: "after", logger: { log() {}, warn() {} },
  })
  assert.equal(after.xiaoc.selected_count, 1)
  assert.equal(after.attempted, true)
})

test("fresh-empty implementation does not alter schema, mobile, or Function count", () => {
  assert.equal(fs.readdirSync("api").filter(name => name.endsWith(".js")).length, 12)
  const mobileMatches = []
  for (const path of ["mobile/XiaoC/src/lib/supabaseAuth.ts", "mobile/XiaoC/src/app/we.tsx"]) {
    const source = fs.readFileSync(path, "utf8")
    if (/OMBRE_ADMIN_PASSWORD|ombre-brain-production|XIAOC_MEMORY_AUTHORITY_MODE/.test(source)) mobileMatches.push(path)
  }
  assert.deepEqual(mobileMatches, [])
})

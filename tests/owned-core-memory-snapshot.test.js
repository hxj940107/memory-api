import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  buildOwnedCoreMemorySnapshot,
  ensureCoreMemorySnapshot,
} from "../lib/coreMemorySnapshot.js"
import { MEMORY_AUTHORITY_MODE } from "../lib/memoryAuthority.js"
import { createMemoryContextBudget } from "../lib/memoryContextGateway.js"
import { retrieveOwnedMemoryPromptCandidatesShadow } from "../lib/xiaocMemoryOwnedRetrievalAdapter.js"

const CREATED_AT = "2026-09-24T00:00:00.000Z"
const ID_A = "10000000-0000-4000-8000-000000000001"
const ID_B = "10000000-0000-4000-8000-000000000002"
const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

function ownedRow(candidate) {
  return {
    owned_core_memory_snapshot: candidate.snapshot,
    owned_core_memory_snapshot_hash: candidate.hash,
    owned_core_memory_snapshot_created_at: CREATED_AT,
    owned_core_memory_source_ids: candidate.sourceMemoryIds,
    owned_core_memory_sources: candidate.sources,
  }
}

function memory(id, canonicalContent) {
  return {
    id,
    user_id: "user",
    canonical_content: canonicalContent,
    content_hash: id === ID_A ? HASH_A : HASH_B,
    origin_system: "ombre_legacy",
    memory_class: "observation",
    category: "relationship_memory",
    provenance_status: "legacy_unverified",
    lifecycle_status: "active",
    retrieval_tier: "low_authority",
    authority_tier: "legacy_limited",
    claim_key: null,
    importance: 10,
    confidence: null,
    event_time: null,
    valid_from: null,
    valid_until: null,
    resolved_at: null,
    created_at: CREATED_AT,
  }
}

test("Owned Core rendering is deterministic by explicit PIN ordinal and preserves canonical bodies", () => {
  const built = buildOwnedCoreMemorySnapshot([
    { ...memory(ID_B, "第二条正文"), ordinal: 1 },
    { ...memory(ID_A, "第一条正文"), ordinal: 0 },
  ])
  assert.equal(built.snapshot, "第一条正文\n\n---\n\n第二条正文")
  assert.deepEqual(built.sourceMemoryIds, [ID_A, ID_B])
  assert.deepEqual(built.sourceContentHashes, [HASH_A, HASH_B])
})

test("same conversation reuses frozen Owned Core without another source initialization", async () => {
  const candidate = buildOwnedCoreMemorySnapshot([{ ...memory(ID_A, "第一条正文"), ordinal: 0 }])
  let stored = null
  let sourceReads = 0
  const args = {
    conversationId: "owned-frozen",
    authorityMode: MEMORY_AUTHORITY_MODE.OWNED_AUTHORITATIVE,
    readSnapshot: async () => stored,
    initializeSnapshot: async () => assert.fail("must not use Ombre initializer"),
    initializeOwnedSnapshot: async () => {
      sourceReads += 1
      stored = ownedRow(candidate)
      return stored
    },
    fetchPinnedMemories: async () => assert.fail("owned mode must not perform Ombre I/O"),
  }
  const first = await ensureCoreMemorySnapshot(args)
  const second = await ensureCoreMemorySnapshot(args)
  assert.equal(first.hash, second.hash)
  assert.equal(first.snapshot, second.snapshot)
  assert.equal(sourceReads, 1)
})

test("concurrent Owned Core initialization converges on the one persisted snapshot", async () => {
  const firstCandidate = buildOwnedCoreMemorySnapshot([{ ...memory(ID_A, "第一版"), ordinal: 0 }])
  const secondCandidate = buildOwnedCoreMemorySnapshot([{ ...memory(ID_B, "第二版"), ordinal: 0 }])
  let stored = null
  let call = 0
  const initializeOwnedSnapshot = async () => {
    const candidate = call++ === 0 ? firstCandidate : secondCandidate
    await Promise.resolve()
    if (!stored) stored = ownedRow(candidate)
    return stored
  }
  const results = await Promise.all([1, 2].map(() => ensureCoreMemorySnapshot({
    conversationId: "owned-concurrent",
    authorityMode: MEMORY_AUTHORITY_MODE.OWNED_AUTHORITATIVE,
    readSnapshot: async () => null,
    initializeOwnedSnapshot,
    initializeSnapshot: async () => assert.fail("must not use Ombre initializer"),
    fetchPinnedMemories: async () => assert.fail("owned mode must not perform Ombre I/O"),
  })))
  assert.equal(results[0].hash, results[1].hash)
  assert.equal(results[0].snapshot, results[1].snapshot)
})

test("Owned retrieval excludes Core source IDs without changing ranking policy", async () => {
  const rows = [memory(ID_A, "她喜欢蓝色石头"), memory(ID_B, "她收藏蓝色纪念石头")]
  const repository = {
    async listLexicalCandidates() { return rows },
    async listSemanticCandidates() { throw new Error("semantic remains disabled") },
    async listRelations() { return [] },
  }
  const result = await retrieveOwnedMemoryPromptCandidatesShadow({
    repository,
    userId: "user",
    query: "蓝色石头",
    retrievalTime: CREATED_AT,
    excludedMemoryIds: [ID_A],
    context: {},
    memoryBudget: createMemoryContextBudget(1000),
    shadowOnly: false,
  })
  assert.equal(result.promptReadyCandidates.some(item => item.memoryId === ID_A), false)
  assert.equal(result.retrieval.results.some(item => item.memory_id === ID_A), false)
  assert.equal(result.retrieval.trace.raw_candidate_count, 1)
})

test("migration permits only explicit eligible native or final historical PINs and never derives PIN from importance", () => {
  const migration = fs.readFileSync("supabase_owned_core_snapshot.sql", "utf8")
  const seed = fs.readFileSync("supabase_owned_core_snapshot_seed_20.sql", "utf8")
  assert.match(migration, /origin_system = 'xiaoc_native'[\s\S]*authority_tier = 'native_verified'/)
  assert.match(migration, /origin_system = 'ombre_legacy'[\s\S]*provenance_status = 'legacy_unverified'[\s\S]*retrieval_tier = 'low_authority'[\s\S]*authority_tier = 'legacy_limited'/)
  assert.match(migration, /lifecycle_status = 'active'/)
  assert.match(migration, /where user_id = p_user_id and id = p_memory_id/)
  assert.doesNotMatch(migration, /importance\s*[>=]/i)
  assert.match(seed, /cardinality\(v_ids\) <> 20/)
  assert.match(seed, /importance = 10\) <> 14/)
  assert.match(seed, /importance = 8\) <> 6/)
  assert.equal((seed.match(/::uuid/g) || []).length, 20)
})

test("Owned snapshot storage is separate, atomic, service-only, and lifecycle-invalidated at write time", () => {
  const migration = fs.readFileSync("supabase_owned_core_snapshot.sql", "utf8")
  assert.match(migration, /owned_core_memory_snapshot text/)
  assert.match(migration, /owned_core_memory_sources jsonb/)
  assert.match(migration, /on conflict \(conversation_id\) do update/)
  assert.match(migration, /where public\.conversation_summary\.owned_core_memory_snapshot is null/)
  assert.match(migration, /after update of lifecycle_status on public\.memory_items/)
  assert.match(migration, /old\.id = any\(coalesce\(cs\.owned_core_memory_source_ids/)
  assert.match(migration, /revoke all on function public\.xiaoc_memory_initialize_owned_core_snapshot[\s\S]*from public, anon, authenticated/)
  assert.match(migration, /grant execute on function public\.xiaoc_memory_initialize_owned_core_snapshot[\s\S]*to service_role/)
  assert.doesNotMatch(migration, /set\s+core_memory_snapshot\s*=/i)
})

test("chat keeps Owned Core in the stable prefix and passes its IDs only as retrieval exclusions", () => {
  const chat = fs.readFileSync("api/chat.js", "utf8")
  assert.match(chat, /initializeOwnedSnapshot:[\s\S]*initializeOwnedCoreMemorySnapshot/)
  assert.match(chat, /excludedMemoryIds: coreMemorySnapshot\.sourceMemoryIds \|\| \[\]/)
  assert.match(chat, /coreMemorySnapshot: `【Identity｜人格层】[\s\S]*\$\{injectedPinMemory\}`/)
  assert.match(chat, /buildCachedPromptMessages/)
})

import assert from "node:assert/strict"
import fs from "node:fs"
import {
  buildCoreMemorySnapshot,
  ensureCoreMemorySnapshot,
  fetchCompletePinnedMemories,
  hashCoreMemorySnapshot,
} from "../lib/coreMemorySnapshot.js"

const asRow = (candidate, createdAt = "2026-08-21T00:00:00.000Z") => ({
  core_memory_snapshot: candidate.snapshot,
  core_memory_snapshot_hash: candidate.hash,
  core_memory_snapshot_created_at: createdAt,
  core_memory_source_bucket_ids: candidate.sourceBucketIds,
})

const pinsA = Array.from({ length: 6 }, (_, index) => ({
  id: `bucket-${index + 1}`,
  content: index === 5 ? `第六条：${"完整正文".repeat(180)}：正文结尾` : `第${index + 1}条正文`,
}))
const pinsB = pinsA.map((item, index) =>
  index === 0 ? { ...item, content: "修改后的第一条正文" } : item
)

{
  const built = buildCoreMemorySnapshot(pinsA)
  const expected = [...pinsA]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => item.content)
    .join("\n\n---\n\n")

  assert.equal(built.snapshot, expected)
  assert.ok(built.snapshot.length > 700)
  assert.ok(built.snapshot.endsWith("：正文结尾"))
  assert.equal(built.hash, hashCoreMemorySnapshot(expected))
  assert.deepEqual(built.sourceBucketIds, pinsA.map((item) => item.id))
}

{
  const rows = new Map()
  let currentPins = pinsA
  let fetchCount = 0
  const readSnapshot = async (conversationId) => rows.get(conversationId) ?? null
  const initializeSnapshot = async (candidate) => {
    if (!rows.has(candidate.conversationId)) rows.set(candidate.conversationId, asRow(candidate))
    return rows.get(candidate.conversationId)
  }
  const fetchPinnedMemories = async () => {
    fetchCount += 1
    return currentPins
  }

  const first = await ensureCoreMemorySnapshot({
    conversationId: "old-conversation",
    readSnapshot,
    initializeSnapshot,
    fetchPinnedMemories,
  })
  currentPins = pinsB
  const second = await ensureCoreMemorySnapshot({
    conversationId: "old-conversation",
    readSnapshot,
    initializeSnapshot,
    fetchPinnedMemories,
  })
  const fresh = await ensureCoreMemorySnapshot({
    conversationId: "new-conversation",
    readSnapshot,
    initializeSnapshot,
    fetchPinnedMemories,
  })

  assert.equal(second.snapshot, first.snapshot)
  assert.notEqual(fresh.snapshot, first.snapshot)
  assert.equal(fetchCount, 2)
}

{
  let persisted = null
  let initializeCount = 0
  await assert.rejects(
    ensureCoreMemorySnapshot({
      conversationId: "retryable-conversation",
      readSnapshot: async () => persisted,
      initializeSnapshot: async (candidate) => {
        initializeCount += 1
        persisted = asRow(candidate)
        return persisted
      },
      fetchPinnedMemories: async () => {
        throw new Error("Ombre unavailable")
      },
    }),
    /Ombre unavailable/
  )
  assert.equal(initializeCount, 0)
  assert.equal(persisted, null)
}

{
  let persisted = null
  const candidates = [pinsA, pinsB]
  let fetchIndex = 0
  const initializeSnapshot = async (candidate) => {
    await Promise.resolve()
    if (!persisted) persisted = asRow(candidate)
    return persisted
  }

  const results = await Promise.all(
    candidates.map(() =>
      ensureCoreMemorySnapshot({
        conversationId: "concurrent-conversation",
        readSnapshot: async () => null,
        initializeSnapshot,
        fetchPinnedMemories: async () => candidates[fetchIndex++],
      })
    )
  )

  assert.equal(results[0].hash, results[1].hash)
  assert.equal(results[0].snapshot, results[1].snapshot)
  assert.equal(results[0].snapshot, persisted.core_memory_snapshot)
}

{
  const fullContent = `完整PIN：${"不会被预览接口截断".repeat(80)}：完整结尾`
  let pinnedListReads = 0
  const fakeFetch = async (url) => {
    const href = String(url)
    if (href.endsWith("/xiaoc/memories")) {
      pinnedListReads += 1
      return new Response(JSON.stringify({ memories: [{ id: "pin-1", pinned: true }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (href.endsWith("/auth/login")) {
      return new Response("{}", { status: 200, headers: { "set-cookie": "session=test" } })
    }
    if (href.endsWith("/api/bucket/pin-1")) {
      return new Response(JSON.stringify({ id: "pin-1", content: fullContent }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    throw new Error(`Unexpected URL: ${href}`)
  }

  const previousPassword = process.env.OMBRE_ADMIN_PASSWORD
  process.env.OMBRE_ADMIN_PASSWORD = "test-password"
  const memories = await fetchCompletePinnedMemories(fakeFetch)
  if (previousPassword === undefined) delete process.env.OMBRE_ADMIN_PASSWORD
  else process.env.OMBRE_ADMIN_PASSWORD = previousPassword
  assert.equal(pinnedListReads, 2)
  assert.equal(memories[0].content, fullContent)
}

{
  const migration = fs.readFileSync("supabase_core_memory_snapshot.sql", "utf8")
  assert.match(migration, /core_memory_snapshot text/)
  assert.match(migration, /core_memory_snapshot_hash text/)
  assert.match(migration, /core_memory_source_bucket_ids text\[\]/)
  assert.match(migration, /on conflict \(conversation_id\)/i)
  assert.match(migration, /where conversation_summary\.core_memory_snapshot is null/i)

  const chat = fs.readFileSync("api/chat.js", "utf8")
  assert.match(chat, /const injectedPinMemory = coreMemorySnapshot\.snapshot/)
  assert.match(chat, /includePinned: false/)
  assert.doesNotMatch(chat, /trimList\(coreMemorySnapshot\.snapshot/)

  const summary = fs.readFileSync("api/summary.js", "utf8")
  assert.match(summary, /\.update\(\{[\s\S]*summary: null/)
  assert.doesNotMatch(summary, /\.from\("conversation_summary"\)\s*\.delete\(\)/)
}

console.log("core memory snapshot tests passed")

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import {
  consolidateStableMemory,
  findConsolidationClusters,
} from "../lib/stableMemoryConsolidation.js"
import {
  prepareStableMemoryCandidates,
  selectStableMemoryContext,
} from "../lib/memoryContextGateway.js"
import { resolveActiveConversationContext } from "../lib/activeConversationContext.js"

function observation(id, messageId, createdAt, overrides = {}) {
  return {
    id,
    content: "她早餐长期喜欢喝不加糖的热豆浆。",
    created_at: createdAt,
    metadata: {
      type: "episodic",
      source_role: "user",
      source_message_id: messageId,
      source_conversation_id: overrides.conversationId || `conversation-${id}`,
      ...overrides.metadata,
    },
    ...overrides.row,
  }
}

function stable(id, content, metadata = {}) {
  return {
    id,
    content,
    created_at: "2026-01-01T00:00:00.000Z",
    metadata: { type: "stable", consolidation: true, ...metadata },
  }
}

class SelectQuery {
  constructor(rows) {
    this.rows = rows
    this.maximum = Infinity
  }
  select() { return this }
  eq() { return this }
  order() { return this }
  limit(value) { this.maximum = value; return this }
  then(resolve, reject) {
    return Promise.resolve({ data: this.rows.slice(0, this.maximum), error: null })
      .then(resolve, reject)
  }
}

class InsertQuery {
  constructor(database, value) {
    this.database = database
    this.value = value
  }
  select() { return this }
  async single() {
    const created = {
      ...this.value,
      id: `stable-created-${this.database.memories.length + 1}`,
      created_at: "2026-04-10T00:00:00.000Z",
    }
    this.database.memories.push(created)
    return { data: created, error: null }
  }
}

function fakeSupabase(rows) {
  const database = { memories: structuredClone(rows), pins: ["core-pin-unchanged"] }
  return {
    database,
    client: {
      from(table) {
        assert.equal(table, "memories")
        return {
          select: () => new SelectQuery(database.memories),
          insert: value => new InsertQuery(database, value),
        }
      },
    },
  }
}

const independent = [
  observation("e1", "m1", "2026-01-01T08:00:00.000Z"),
  observation("e2", "m2", "2026-02-01T08:00:00.000Z"),
  observation("e3", "m3", "2026-03-01T08:00:00.000Z"),
]

// 1. Three independent observations consolidate with one model call.
{
  const fake = fakeSupabase(independent)
  let calls = 0
  const result = await consolidateStableMemory({
    supabase: fake.client,
    userId: "u1",
    newMemoryId: "e3",
    callSmallModel: async () => {
      calls += 1
      return JSON.stringify({
        should_consolidate: true,
        proposed_content: "她早餐稳定偏好不加糖的热豆浆。",
        confidence: 0.94,
        source_memory_ids: ["e1", "e2", "e3"],
        supersedes_stable_id: null,
        conflict: false,
      })
    },
    now: () => "2026-04-01T00:00:00.000Z",
    logger: { log() {} },
  })
  assert.equal(calls, 1)
  assert.equal(result.stable_action, "created")
  assert.equal(fake.database.memories.length, 4)

  // 8, 9, 10. Provenance is complete; sources and Core/PIN remain untouched.
  const created = fake.database.memories[3]
  assert.deepEqual([...created.metadata.source_memory_ids].sort(), ["e1", "e2", "e3"])
  assert.deepEqual([...created.metadata.source_message_ids].sort(), ["m1", "m2", "m3"])
  assert.deepEqual([...created.metadata.source_conversation_ids].sort(), ["conversation-e1", "conversation-e2", "conversation-e3"])
  assert.equal(created.metadata.consolidated_at, "2026-04-01T00:00:00.000Z")
  assert.equal(created.metadata.consolidation, true)
  assert.equal(created.metadata.confidence, 0.94)
  assert.equal(created.metadata.supersedes_stable_id, null)
  assert.deepEqual(fake.database.memories.slice(0, 3).map(item => item.id), ["e1", "e2", "e3"])
  assert.deepEqual(fake.database.pins, ["core-pin-unchanged"])
}

// 2. Repetition from one round/message is not independent evidence.
{
  const sameRound = [
    observation("r1", "same-message", "2026-01-01T08:00:00.000Z"),
    observation("r2", "same-message", "2026-01-01T08:00:00.000Z"),
    observation("r3", "same-message", "2026-01-01T08:00:00.000Z"),
  ]
  assert.deepEqual(findConsolidationClusters(sameRound, "r3"), [])
}

// 3. A single event cannot form a cluster.
{
  const singleEvents = independent.map(item => ({
    ...item,
    content: "她这次早餐临时喝了一杯热豆浆。",
  }))
  assert.deepEqual(findConsolidationClusters(singleEvents, "e3"), [])
}

// 4. Assistant inference is excluded as evidence.
{
  const inferred = independent.map(item => ({
    ...item,
    metadata: { ...item.metadata, source_role: "assistant" },
  }))
  assert.deepEqual(findConsolidationClusters(inferred, "e3"), [])
}

// 5. An exact existing Stable Memory prevents a duplicate and avoids the LLM.
{
  const fake = fakeSupabase([
    ...independent,
    stable("s1", independent[0].content),
  ])
  let called = false
  const result = await consolidateStableMemory({
    supabase: fake.client,
    userId: "u1",
    newMemoryId: "e3",
    callSmallModel: async () => { called = true },
    logger: { log() {} },
  })
  assert.equal(called, false)
  assert.equal(result.reason, "duplicate_existing_stable")
  assert.equal(fake.database.memories.length, 4)
}

// 6. A supported update creates a new Stable row that supersedes the old row.
{
  const fake = fakeSupabase([
    ...independent,
    stable("s-old", "她早餐以前习惯喝加糖豆浆。"),
  ])
  const result = await consolidateStableMemory({
    supabase: fake.client,
    userId: "u1",
    newMemoryId: "e3",
    callSmallModel: async () => JSON.stringify({
      should_consolidate: true,
      proposed_content: "她现在早餐稳定偏好不加糖的热豆浆。",
      confidence: 0.91,
      source_memory_ids: ["e1", "e2", "e3"],
      supersedes_stable_id: "s-old",
      conflict: false,
    }),
    logger: { log() {} },
  })
  assert.equal(result.stable_action, "updated")
  assert.equal(fake.database.memories.at(-1).metadata.supersedes_stable_id, "s-old")
  assert.ok(fake.database.memories.some(item => item.id === "s-old"))
}

// 7. Conflict is logged and skipped without overwriting or merging.
{
  const fake = fakeSupabase([...independent, stable("s-old", "她早餐偏好甜豆浆。")])
  const result = await consolidateStableMemory({
    supabase: fake.client,
    userId: "u1",
    newMemoryId: "e3",
    callSmallModel: async () => JSON.stringify({
      should_consolidate: false,
      proposed_content: "",
      confidence: 0.5,
      source_memory_ids: ["e1", "e2", "e3"],
      supersedes_stable_id: null,
      conflict: true,
    }),
    logger: { log() {} },
  })
  assert.equal(result.reason, "conflict")
  assert.equal(fake.database.memories.length, 4)
}

// 11. Consolidated Stable Memory still goes through P0 suppression in Gateway.
{
  const result = selectStableMemoryContext({
    candidates: [{
      memoryId: "s-new",
      candidateId: "s-new",
      source: "stable",
      content: "她早餐稳定偏好不加糖的热豆浆。",
    }],
    context: {
      currentConversationId: "conversation-current",
      recentTexts: ["她刚说早餐稳定偏好不加糖的热豆浆。"],
    },
    maxChars: 500,
    logger: { log() {} },
  })
  assert.deepEqual(result.memories, [])
  assert.equal(result.diagnostics[0].suppression_reason, "duplicate_recent")

  const recentConsolidation = selectStableMemoryContext({
    candidates: [{
      memoryId: "s-current",
      candidateId: "s-current",
      source: "stable",
      content: "她早餐稳定偏好不加糖的热豆浆。",
      conversationIds: ["conversation-current"],
    }],
    context: { currentConversationId: "conversation-current" },
    maxChars: 500,
    logger: { log() {} },
  })
  assert.equal(recentConsolidation.diagnostics[0].suppression_reason, "recently_created")

  const prepared = prepareStableMemoryCandidates([
    stable("s-old", "她早餐以前喜欢加糖豆浆。"),
    stable("s-new", "她现在喜欢不加糖豆浆。", { supersedes_stable_id: "s-old" }),
  ])
  assert.deepEqual(prepared.map(item => item.memoryId), ["s-new"])
}

// 12. Retrieval/injection cannot refresh Active attention.
{
  const active = {
    items: [{
      topic: "早餐豆浆",
      context: "她早餐喝不加糖热豆浆。",
      kind: "transient",
      status: "active",
      source_message_id: "old-user-message",
      last_referenced_message_id: "old-user-message",
      missed_turns: 1,
    }],
  }
  const next = resolveActiveConversationContext(active, active, {
    currentUserMessageId: "unrelated-user-message",
    retrievedMemoryId: "s-new",
  })
  assert.equal(next.items[0].missed_turns, 2)
}

// 13. Vercel endpoint count stays at the Hobby limit.
{
  const apiCount = fs.readdirSync(path.join(process.cwd(), "api"))
    .filter(name => name.endsWith(".js")).length
  assert.equal(apiCount, 12)
}

console.log("stable memory consolidation tests passed")

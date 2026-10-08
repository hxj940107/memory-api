import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { queryFixture } from "./helpers/queryFixture.js"
import { XiaoCMemoryEmbeddingRepository, reconcileMissingNativeEmbeddings, hashEmbeddingInput } from "../lib/xiaocMemoryEmbedding.js"
import { isXiaoCMemorySemanticRetrievalEnabled } from "../lib/aiConfig.js"

const identity = { providerId: "fixture", modelId: "fixture-model", version: "v1", preprocessorVersion: "canonical-v1", dimension: 3 }
const memory = { id: "m", user_id: "user", canonical_content: "offline fixture", content_hash: hashEmbeddingInput("offline fixture"), origin_system: "xiaoc_native", provenance_status: "verified_user", lifecycle_status: "active", retrieval_tier: null, authority_tier: "native_verified" }
const healthy = { memory_id: "m", user_id: "user", provider: "fixture", model: "fixture-model", embedding_version: "v1", preprocessor_version: "canonical-v1", dimensions: 3, content_hash: memory.content_hash, rollout_status: "active", embedding: [1, 0, 0] }

test("healthy reconciliation selects only compatibility fields, owner scopes and never repairs", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ ...memory, id: `m${i}`, created_at: String(i).padStart(2, "0") }))
  const client = queryFixture({ memory_items: rows, memory_embeddings: rows.map(m => ({ ...healthy, memory_id: m.id, embedding: Array(1536).fill(0.1234) })) })
  const result = await reconcileMissingNativeEmbeddings({ client, provider: { ...identity, embed() { assert.fail("healthy must not embed") } }, limit: 3 })
  assert.deepEqual(result, { scanned: 9, repaired: 0 })
  assert.equal(client.reads.length, 10)
  for (const read of client.reads.filter(r => r.table === "memory_embeddings")) {
    assert.ok(!read.fields.split(",").includes("embedding"))
    assert.equal(read.data[0].embedding, undefined)
  }
  const repo = new XiaoCMemoryEmbeddingRepository(client)
  assert.equal(await repo.readActiveMetadata({ userId: "other", memoryId: "m0" }), null)
  assert.deepEqual((await repo.readActive({ userId: "user", memoryId: "m0" })).embedding, Array(1536).fill(0.1234))
})

for (const [name, row] of [
  ["missing", null], ["hash mismatch", { ...healthy, content_hash: "old" }],
  ["dimension mismatch", { ...healthy, dimensions: 2 }], ["version mismatch", { ...healthy, embedding_version: "old" }],
]) test(`${name} still enters the unchanged repair lifecycle`, async () => {
  const client = queryFixture({ memory_items: [memory], memory_embeddings: row ? [row] : [] })
  const operations = []; let generated = 0
  client.rpc = async name => { operations.push(name); return { data: "operation", error: null } }
  const result = await reconcileMissingNativeEmbeddings({ client, provider: { ...identity, async embed() { generated++; return [[1, 0, 0]] } }, logger: { log() {}, warn() {} } })
  assert.equal(result.repaired, 1)
  assert.equal(generated, 1)
  assert.deepEqual(operations, ["xiaoc_memory_register_embedding", "xiaoc_memory_activate_embedding"])
  assert.equal(client.reads[1].fields.includes(",embedding,"), false)
})

test("semantic off keeps reconciliation gated, and failed repairs remain bounded per run", async () => {
  assert.equal(isXiaoCMemorySemanticRetrievalEnabled({}), false)
  assert.equal(isXiaoCMemorySemanticRetrievalEnabled({ XIAOC_MEMORY_SEMANTIC_RETRIEVAL_ENABLED: "false" }), false)
  const source = readFileSync("api/memory.js", "utf8")
  assert.match(source, /isXiaoCMemorySemanticRetrievalEnabled\(process.env\)\s*\? await reconcileMissingNativeEmbeddings/)
  const client = queryFixture({ memory_items: [memory], memory_embeddings: [] }); let attempts = 0
  const result = await reconcileMissingNativeEmbeddings({ client, provider: { ...identity, async embed() { attempts++; throw new Error("offline failure") } }, logger: { warn() {} } })
  assert.deepEqual(result, { scanned: 1, repaired: 0 }); assert.equal(attempts, 1)
})

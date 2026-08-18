import assert from "node:assert/strict"
import {
  selectSummaryBatch,
  splitOversizedSummaryMessage,
  processSummaryBatch,
} from "../lib/summaryBatch.js"

const makeMessage = (id, content) => ({
  id,
  role: id % 2 ? "user" : "assistant",
  content,
  created_at: `2026-08-18T00:00:${String(id).padStart(2, "0")}.000Z`,
})

{
  const messages = [makeMessage(1, "第一条"), makeMessage(2, "第二条")]
  const batch = selectSummaryBatch(messages, { maxMessages: 10, maxChars: 100 })

  assert.deepEqual(batch.messages.map((item) => item.id), [1, 2])
  assert.equal(batch.hasMore, false)
}

{
  const batch = selectSummaryBatch([makeMessage(1, "需要摘要")])
  const saved = []
  const result = await processSummaryBatch({
    oldSummary: "旧摘要",
    batch,
    summarize: async () => "新摘要",
    save: async (summary, checkpoint) => saved.push({ summary, checkpoint }),
  })

  assert.equal(result.checkpoint, batch.messages[0].created_at)
  assert.deepEqual(saved, [{ summary: "新摘要", checkpoint: result.checkpoint }])
}

{
  const batch = selectSummaryBatch([makeMessage(1, "不能跳过")])
  let saveCalled = false

  await assert.rejects(
    processSummaryBatch({
      oldSummary: "旧摘要",
      batch,
      summarize: async () => {
        throw new Error("model failed")
      },
      save: async () => {
        saveCalled = true
      },
    }),
    /model failed/
  )
  assert.equal(saveCalled, false)
}

{
  const batch = selectSummaryBatch([makeMessage(1, "保存失败也不能推进")])

  await assert.rejects(
    processSummaryBatch({
      oldSummary: "旧摘要",
      batch,
      summarize: async () => "已经生成但尚未保存的摘要",
      save: async () => {
        throw new Error("database failed")
      },
    }),
    /database failed/
  )
}

{
  const messages = Array.from({ length: 8 }, (_, index) =>
    makeMessage(index + 1, "x".repeat(20))
  )
  const first = selectSummaryBatch(messages, { maxMessages: 3, maxChars: 1000 })
  const remaining = messages.slice(first.messages.length)
  const second = selectSummaryBatch(remaining, { maxMessages: 3, maxChars: 1000 })

  assert.deepEqual(first.messages.map((item) => item.id), [1, 2, 3])
  assert.equal(first.hasMore, true)
  assert.deepEqual(second.messages.map((item) => item.id), [4, 5, 6])
}

{
  const messages = [
    makeMessage(1, "a".repeat(40)),
    makeMessage(2, "b".repeat(40)),
    makeMessage(3, "c".repeat(40)),
  ]
  const batch = selectSummaryBatch(messages, { maxMessages: 10, maxChars: 70 })

  assert.deepEqual(batch.messages.map((item) => item.id), [1])
  assert.equal(batch.hasMore, true)
}

{
  const oversized = makeMessage(1, "z".repeat(125))
  const batch = selectSummaryBatch([oversized], { maxMessages: 10, maxChars: 50 })
  const chunks = splitOversizedSummaryMessage(oversized, 40)

  assert.equal(batch.oversizedSingleMessage, true)
  assert.equal(chunks.length, 4)
  assert.equal(
    chunks.map((chunk) => chunk.split("\n").slice(1).join("\n")).join(""),
    oversized.content
  )
}

console.log("summary batch tests passed")

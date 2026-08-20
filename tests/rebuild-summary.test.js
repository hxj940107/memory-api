import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  REBUILD_CONVERSATION_ID,
  hashText,
  rebuildSummary,
  validateRebuiltSummary,
} from "../scripts/rebuild-conversation-summary.js"

assert.equal(REBUILD_CONVERSATION_ID, "chat_1783598999283")
assert.equal(hashText("same"), hashText("same"))
assert.notEqual(hashText("same"), hashText("different"))

assert.deepEqual(validateRebuiltSummary("a".repeat(1500)), {
  summaryChars: 1500,
  maxSummaryChars: 1500,
  nonEmpty: true,
  withinLengthLimit: true,
  applyEligible: true,
})

assert.equal(validateRebuiltSummary("a".repeat(1501)).applyEligible, false)
assert.equal(validateRebuiltSummary("").applyEligible, false)

const sourceSummary = "异常旧摘要".repeat(2000)
const sourceMessages = Array.from({ length: 55 }, (_, index) => ({
  id: index + 1,
  role: index % 2 ? "assistant" : "user",
  content: `第${index + 1}条消息：${"内容".repeat(200)}`,
  created_at: new Date(Date.UTC(2026, 7, 18, 0, 0, index)).toISOString(),
}))

class FakeQuery {
  constructor(table) {
    this.table = table
    this.orders = []
    this.rangeValue = null
    this.limitValue = null
    this.single = false
  }

  select() { return this }
  eq() { return this }
  lte() { return this }
  lt() { return this }
  order(column, options) {
    this.orders.push({ column, ascending: options?.ascending !== false })
    return this
  }
  limit(value) {
    this.limitValue = value
    return this
  }
  range(from, to) {
    this.rangeValue = [from, to]
    return this
  }
  maybeSingle() {
    this.single = true
    return this
  }

  then(resolve, reject) {
    let result

    if (this.table === "conversation_summary") {
      result = this.single
        ? {
            data: {
              summary: sourceSummary,
              last_summarized_at: sourceMessages[sourceMessages.length - 1].created_at,
              updated_at: "2026-07-28T15:28:17.090Z",
            },
            error: null,
          }
        : {
            data: [{
              conversation_id: REBUILD_CONVERSATION_ID,
              last_summarized_at: sourceMessages[sourceMessages.length - 1].created_at,
              updated_at: "2026-07-28T15:28:17.090Z",
            }],
            error: null,
          }
    } else if (this.limitValue === 1 && !this.rangeValue) {
      const latest = sourceMessages[sourceMessages.length - 1]
      result = { data: { id: latest.id, created_at: latest.created_at }, error: null }
    } else {
      const [from, to] = this.rangeValue
      result = { data: sourceMessages.slice(from, to + 1), error: null }
    }

    return Promise.resolve(result).then(resolve, reject)
  }
}

const fakeSupabase = {
  from(table) {
    assert.ok(["conversation_summary", "messages"].includes(table))
    return new FakeQuery(table)
  },
}
const originalFetch = globalThis.fetch
let modelCalls = 0
globalThis.fetch = async () => {
  modelCalls += 1
  return {
    ok: true,
    async json() {
      return {
        choices: [{ message: { content: `第${modelCalls}批重建摘要` } }],
        usage: { prompt_tokens: 1000 + modelCalls, completion_tokens: 100 + modelCalls },
      }
    },
  }
}

try {
  const directory = mkdtempSync(join(tmpdir(), "xiaoc-summary-rebuild-"))
  const outputPath = join(directory, "artifact.json")
  const artifact = await rebuildSummary({
    supabase: fakeSupabase,
    conversationId: REBUILD_CONVERSATION_ID,
    outputPath,
  })
  const savedArtifact = JSON.parse(readFileSync(outputPath, "utf8"))

  assert.equal(artifact.source.originalSummarySha256, hashText(sourceSummary))
  assert.equal(artifact.source.oldSummary, sourceSummary)
  assert.equal(artifact.source.trust.reason, "legacy_prompt")
  assert.equal(artifact.legacyScope.count, 1)
  assert.equal(artifact.snapshot.messageCount, 55)
  assert.equal(artifact.snapshot.finalMessageId, 55)
  assert.equal(artifact.totals.batchCount, 2)
  assert.equal(artifact.totals.modelCallCount, 2)
  assert.equal(artifact.batches[0].messageRange.firstId, 1)
  assert.equal(artifact.batches[0].messageRange.lastId, 43)
  assert.equal(artifact.batches[1].messageRange.firstId, 44)
  assert.equal(artifact.batches[1].messageRange.lastId, 55)
  assert.equal(artifact.totals.inputTokens, 2003)
  assert.equal(artifact.totals.outputTokens, 203)
  assert.equal(artifact.result.applyEligible, true)
  assert.equal(artifact.result.applySupportedByThisScript, false)
  assert.equal(artifact.result.semanticValidation.valid, true)
  assert.deepEqual(savedArtifact, artifact)
} finally {
  globalThis.fetch = originalFetch
}

console.log("summary rebuild tests passed")

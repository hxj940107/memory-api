import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"
import { readFileSync } from "node:fs"
import { queryFixture } from "./helpers/queryFixture.js"
import { getInactivityReconciliationSource, planInactivityLifecycleRecovery, capInactivityOpportunityAtCeiling } from "../lib/inactivityReachOut.js"

const now = new Date("2026-10-08T08:00:00Z")
const message = { id: "m", user_id: "user", conversation_id: "c", role: "assistant", content: "offline reply", created_at: "2026-10-08T06:00:00Z", metadata: { replyToUserMessageId: "u", imageUrl: "data:image/jpeg;base64," + "A".repeat(500_000) } }
function fixture({ mode = "normal", messages = [message], tasks = [], beforeRead, quiet = false } = {}) {
  const tables = { messages: structuredClone(messages), xiaoc_proactive_tasks: structuredClone(tasks) }
  const client = queryFixture(tables, { beforeRead }); const originalFrom = client.from; const writes = []
  client.from = table => {
    const query = originalFrom(table)
    query.upsert = record => {
      writes.push(record)
      const old = tables[table].find(r => r.user_id === record.user_id && r.type === record.type && r.source_id === record.source_id && r.source_type === record.source_type)
      const row = { id: old?.id || "task", ...record }
      if (old) Object.assign(old, row); else tables[table].push(row)
      return { select() { return { single: async () => ({ data: row, error: null }) } } }
    }
    return query
  }
  const source = readFileSync("api/memory.js", "utf8")
  const section = source.slice(source.indexOf("async function reconcileInactivityLifecycle("), source.indexOf("async function consumePendingInactivityWithProactiveMessage("))
  const run = vm.runInNewContext(`${section}\nreconcileInactivityLifecycle`, {
    supabase: client, getCurrentInactivityReachOutMode: async () => mode,
    getInactivityReconciliationSource, planInactivityLifecycleRecovery, capInactivityOpportunityAtCeiling,
    getInactivityReachOutDelayMinutes: () => 150,
    isProactiveQuietHours: () => quiet,
    getNextProactiveMorning: () => "2026-10-09T00:00:00Z",
    trimText: (text, limit) => String(text || "").slice(0, limit), Date,
  })
  return { run: () => run({ userId: "user", now }), client, tables, writes }
}

test("off reads no message; an existing active lifecycle never downloads text or metadata", async () => {
  const off = fixture({ mode: "off" }); assert.equal((await off.run()).reason, "hard_opt_out"); assert.equal(off.client.reads.length, 0)
  const active = fixture({ tasks: [{ id: "t", user_id: "user", conversation_id: "c", type: "inactivity_reach_out", status: "pending", payload: { silence_anchor_message_id: "m", silence_anchor_at: message.created_at } }] })
  assert.equal((await active.run()).reason, "active_lifecycle_exists")
  assert.equal(active.writes.length, 0)
  const read = active.client.reads.find(r => r.table === "messages")
  assert.equal(read.fields, "id,conversation_id,role,created_at")
  assert.equal(read.data[0].content, undefined); assert.equal(read.data[0].metadata, undefined)
})

test("missing lifecycle preserves source, anchor, ceiling and is idempotent without images", async () => {
  const f = fixture(); assert.equal((await f.run()).recovered, true)
  const task = f.writes[0]
  assert.equal(task.source_type, "message"); assert.equal(task.source_id, "u")
  assert.equal(task.payload.silence_anchor_message_id, "m")
  assert.equal(task.payload.silence_anchor_at, message.created_at)
  assert.equal(task.payload.silence_ceiling_at, "2026-10-08T18:00:00.000Z")
  assert.equal(task.payload.assistant_reply, message.content)
  assert.equal((await f.run()).reason, "active_lifecycle_exists"); assert.equal(f.writes.length, 1)
  for (const read of f.client.reads.filter(r => r.table === "messages")) assert.doesNotMatch(JSON.stringify(read.data), /base64|AAAA/)
})

test("terminal history and quiet hours preserve decline history and original ceiling", async () => {
  const f = fixture({ quiet: true, tasks: [{ id: "old", user_id: "user", conversation_id: "c", type: "inactivity_reach_out", status: "skipped", source_type: "message", source_id: "u", last_error: "model_declined", payload: { assistant_message_id: "m", prior_decline_count: 2, reconsideration_count: 3, previous_proactive_message_ids: ["p"] } }] })
  await f.run(); const payload = f.writes[0].payload
  assert.equal(payload.prior_decline_count, 2); assert.equal(payload.reconsideration_count, 3)
  assert.equal(payload.reconciled_from_terminal_task_id, "old")
  assert.equal(payload.silence_anchor_at, message.created_at)
  assert.equal(f.writes[0].due_at, "2026-10-08T17:40:00.000Z")
})

test("old metadata and proactive source identity retain their previous fallback behavior", async () => {
  for (const [role, metadata, sourceType, sourceId] of [["user", {}, "message", "m"], ["assistant", {}, "reconciled_message", "m"], ["assistant", { proactive: true }, "proactive_message", "m"]]) {
    const f = fixture({ messages: [{ ...message, role, metadata }] }); await f.run()
    assert.equal(f.writes[0].source_type, sourceType); assert.equal(f.writes[0].source_id, sourceId)
  }
})

test("a new message between stages retries immediately and never restores the stale anchor", async () => {
  let f, raced = false
  f = fixture({ beforeRead({ table, fields }) {
    if (!raced && table === "messages" && fields.includes("proactive:")) {
      raced = true; f.tables.messages.push({ ...message, id: "new", role: "user", metadata: {}, created_at: "2026-10-08T07:00:00Z" })
    }
  } })
  await f.run(); assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].payload.silence_anchor_message_id, "new")
  assert.equal(f.writes[0].payload.silence_anchor_at, "2026-10-08T07:00:00Z")
})

test("continuous races are bounded and fail closed without creating an old task", async () => {
  let f, sequence = 0
  f = fixture({ beforeRead({ table, fields }) {
    if (table === "messages" && fields.includes("proactive:")) f.tables.messages.push({ ...message, id: `new${++sequence}`, created_at: `2026-10-08T07:0${sequence}:00Z` })
  } })
  assert.equal((await f.run()).reason, "conversation_advanced_during_reconciliation")
  assert.equal(f.writes.length, 0); assert.equal(sequence, 2)
})

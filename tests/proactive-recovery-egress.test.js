import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"
import { readFileSync } from "node:fs"
import { queryFixture } from "./helpers/queryFixture.js"
import { normalizeProactiveAttentionCandidates } from "../lib/proactiveAttentionCandidates.js"
import { planExistingCandidateWakeupReconciliation } from "../lib/proactiveAttentionReconciliation.js"

const now = "2026-10-08T07:00:00.000Z"
function candidate(overrides = {}) {
  return { event_id: "e", description: "offline follow-up", source_message_ids: ["u"], state: "planned", expected_window: { start: "2026-10-09T07:00:00.000Z", end: "2026-10-09T10:00:00.000Z" }, follow_up_profile: { result_expected: true, result_uncertainty: "meaningful", significance: "high", routine: false, immediate_continuation: false }, last_user_update: { message_id: "u", created_at: "2026-10-08T06:00:00.000Z" }, attention_status: "open", created_at: "2026-10-08T06:00:00.000Z", updated_at: "2026-10-08T06:00:00.000Z", ...overrides }
}
function assistant(id, conversation_id, candidates, created_at = "2026-10-08T06:00:00.000Z") {
  return { id, conversation_id, user_id: "user", role: "assistant", created_at, metadata: { proactiveAttentionCandidates: candidates, imageUrl: "data:image/jpeg;base64," + "A".repeat(500_000), irrelevant: true } }
}
function fixture(messages, tasks = []) {
  const tables = { messages, xiaoc_proactive_tasks: tasks }; const client = queryFixture(tables); const writes = []
  const from = client.from
  client.from = table => {
    const q = from(table)
    q.upsert = row => { writes.push(row); return { select() { return { single: async () => ({ data: { id: "t", ...row }, error: null }) } } } }
    q.update = row => { writes.push(row); return { eq() { return this }, then(resolve) { return Promise.resolve({ error: null }).then(resolve) } } }
    return q
  }
  const source = readFileSync("api/memory.js", "utf8")
  const body = source.slice(source.indexOf("async function reconcileExistingProactiveAttentionWakeups("), source.indexOf("async function findExistingProactiveAttentionMessage("))
  const fn = vm.runInNewContext(`${body}\nreconcileExistingProactiveAttentionWakeups`, { supabase: client, APP_USER: { defaultUserId: "user" }, PROACTIVE_RECONCILIATION_LOOKBACK_MS: 8 * 86400000, PROACTIVE_RECONCILIATION_SNAPSHOT_LIMIT: 120, PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE: "proactive_attention_wakeup", PROACTIVE_ATTENTION_WAKEUP_SOURCE_TYPE: "proactive_event", normalizeProactiveAttentionCandidates, planExistingCandidateWakeupReconciliation, Date })
  return { run: () => fn({ userId: "user", now }), client, writes }
}
const sourceMessage = (id = "u", conversation_id = "c", user_id = "user") => ({ id, conversation_id, user_id, role: "user", created_at: "2026-10-08T05:00:00.000Z" })

test("no candidates, old null fields and latest empty snapshot retain the original selection", async () => {
  const f = fixture([assistant("old", "c", [candidate()]), assistant("new", "c", [], "2026-10-08T06:30:00.000Z"), assistant("legacy", "other", null)])
  assert.equal((await f.run()).candidates, 0); assert.equal(f.writes.length, 0)
  assert.equal(f.client.reads.length, 1)
  assert.doesNotMatch(JSON.stringify(f.client.reads[0].data), /base64|irrelevant/)
})

test("equal-time sorting, multiple conversations, owner and eight-day window stay unchanged", async () => {
  const f = fixture([
    assistant("a", "c", [candidate({ event_id: "old" })]), assistant("z", "c", [candidate()]),
    assistant("b", "d", [candidate({ event_id: "e2", source_message_ids: ["u2"], last_user_update: { message_id: "u2", created_at: now } })]),
    assistant("expired", "expired", [candidate()], "2026-09-29T00:00:00.000Z"),
    { ...assistant("other-owner", "other-owner", [candidate()]), user_id: "other" },
    sourceMessage(), sourceMessage("u2", "d"),
  ])
  const result = await f.run(); assert.equal(result.created, 2)
  assert.deepEqual(f.writes.map(t => t.source_id).sort(), ["e", "e2"])
  assert.equal(result.scanned_snapshots, 2)
  assert.ok(f.client.reads.every(r => !JSON.stringify(r.data).includes("base64")))
})

for (const status of ["pending", "processing", "completed"]) test(`an existing ${status} task is not recreated`, async () => {
  const event = candidate()
  const f = fixture([assistant("a", "c", [event]), sourceMessage()], [{ id: "t", user_id: "user", type: "proactive_attention_wakeup", source_type: "proactive_event", source_id: "e", status, due_at: event.expected_window.start, payload: { candidate_updated_at: event.updated_at }, completed_at: now }])
  assert.equal((await f.run()).unchanged, 1); assert.equal(f.writes.length, 0)
})

for (const state of ["completed", "cancelled"]) test(`${state} candidate stays terminal`, async () => {
  const f = fixture([assistant("a", "c", [candidate({ state, attention_status: "closed" })]), sourceMessage()])
  assert.equal((await f.run()).rejected, 1); assert.equal(f.writes.length, 0)
})

test("source in a different conversation or owner cannot restore a task", async () => {
  for (const invalid of [sourceMessage("u", "other"), sourceMessage("u", "c", "other")]) {
    const f = fixture([assistant("a", "c", [candidate()]), invalid])
    assert.equal((await f.run()).reasons.invalid_source_message, 1); assert.equal(f.writes.length, 0)
  }
})

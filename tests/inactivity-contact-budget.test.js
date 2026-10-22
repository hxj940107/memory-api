import test from "node:test"
import { withoutModelMigration } from "./helpers/model-migration-snapshot.js"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import {
  INACTIVITY_BUDGET_TYPE, readInactivityBudget, reserveInactivityContact,
  persistInactivityCandidate, releaseInactivityContact, updateInactivityContact,
  getInactivitySoftFallbackAt,
} from "../lib/inactivityContactBudget.js"
import { canUseInactivitySoftFallback } from "../lib/inactivityGeneration.js"
import { getInactivitySilenceState, planInactivityReconsideration } from "../lib/inactivityReachOut.js"

const task = { id: 10, user_id: "fixture-owner", conversation_id: "fixture-chat", type: "inactivity_reach_out",
  payload: { silence_anchor_message_id: "fixture-anchor", silence_anchor_at: "2026-01-01T00:00:00Z" } }
const ordinary = new Date("2026-01-01T01:00:00Z")
const ceiling = new Date("2026-01-01T11:40:00Z")
const good = { content: "Synthetic accepted contact.", diagnostics: { should_send: true } }
const declined = { skipped: true, content: null, diagnostics: { skip_reason: "model_declined" } }

// Implements conflict-ignore and compare-and-swap at the database operation boundary.
function ledgerFixture() {
  const rows = []
  return { rows, from(table) {
    assert.equal(table, "xiaoc_proactive_tasks")
    const filters = []
    let patch = null
    const q = {
      select() { return q }, eq(key, value) { filters.push([key, value]); return q },
      update(value) { patch = value; return q },
      async upsert(value, options) {
        assert.equal(options.ignoreDuplicates, true)
        assert.equal(value.status, "completed")
        const old = rows.find(r => ["user_id", "type", "source_type", "source_id"].every(k => r[k] === value[k]))
        if (!old) rows.push({ id: rows.length + 1, ...structuredClone(value) })
        return { error: null }
      },
      async maybeSingle() {
        const row = rows.find(r => filters.every(([k, v]) =>
          k === "payload->>revision" ? String(r.payload.revision) === v : r[k] === v))
        if (row && patch) Object.assign(row, structuredClone(patch))
        return { data: row ? structuredClone(row) : null, error: null }
      },
    }
    return q
  } }
}

test("two ordinary calls leave two ceiling slots; all rejected calls consume allowance", async () => {
  const db = ledgerFixture()
  for (let i = 0; i < 2; i++) {
    const r = await reserveInactivityContact(db, task, ordinary)
    assert.ok(r.token)
    await persistInactivityCandidate(db, r, declined, ordinary)
  }
  const waiting = await reserveInactivityContact(db, task, ordinary)
  assert.equal(waiting.wait, true)
  assert.equal(waiting.dueAt, getInactivitySilenceState(task).contact_deadline_at)
  for (let i = 0; i < 2; i++) {
    const r = await reserveInactivityContact(db, task, ceiling)
    assert.ok(r.token)
    await persistInactivityCandidate(db, r, declined, ceiling)
  }
  assert.equal((await reserveInactivityContact(db, task, ceiling)).reason, "inactivity_paid_budget_exhausted")
  assert.equal(db.rows[0].payload.ordinary + db.rows[0].payload.ceiling, 4)
})

test("concurrent workers reserve exactly once; late writer loses ownership", async () => {
  const db = ledgerFixture()
  const results = await Promise.all([reserveInactivityContact(db, task, ordinary), reserveInactivityContact(db, { ...task, id: 11 }, ordinary)])
  assert.equal(results.filter(r => r.token).length, 1)
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].payload.ordinary, 1)
  const first = results.find(r => r.token)
  const takeover = await reserveInactivityContact(db, task, new Date(ordinary.getTime() + 16 * 60000))
  assert.ok(takeover.token)
  await assert.rejects(persistInactivityCandidate(db, first, good, ordinary), /OWNERSHIP_LOST/)
})

test("recreated task cannot reset budget; new anchor has a separate window; legacy progress fails closed", async () => {
  const db = ledgerFixture()
  for (let i = 0; i < 2; i++) {
    const r = await reserveInactivityContact(db, task, ceiling)
    await releaseInactivityContact(db, r)
  }
  assert.equal((await reserveInactivityContact(db, { ...task, id: 99, payload: { ...task.payload, reconsideration_count: 0 } }, ceiling)).blocked, true)
  const next = { ...task, payload: { silence_anchor_message_id: "next-anchor", silence_anchor_at: ceiling.toISOString() } }
  assert.ok((await reserveInactivityContact(db, next, ceiling)).token)
  const old = { ...task, payload: { ...task.payload, silence_anchor_message_id: "legacy-anchor", reconsideration_count: 9 } }
  assert.equal((await reserveInactivityContact(db, old, ceiling)).blocked, true)
})

test("provider failure and process crash consume reservations, even without valid model output", async () => {
  const db = ledgerFixture()
  const r = await reserveInactivityContact(db, task, ceiling)
  await updateInactivityContact(db, r, { last_failure: "provider_failed", lease_token: null, lease_until: null })
  const crashed = await reserveInactivityContact(db, task, ceiling)
  assert.ok(crashed.token)
  const later = await reserveInactivityContact(db, task, new Date(ceiling.getTime() + 16 * 60000))
  assert.equal(later.blocked, true)
  assert.equal(db.rows[0].payload.ceiling, 2)
})

test("accepted content survives delivery failure without another generation allowance", async () => {
  const db = ledgerFixture()
  const r = await reserveInactivityContact(db, task, ceiling)
  await persistInactivityCandidate(db, r, good, ceiling)
  await releaseInactivityContact(db, r)
  const retry = await reserveInactivityContact(db, { ...task, id: 77 }, new Date(ceiling.getTime() + 5 * 60000))
  assert.deepEqual(retry.generation, good)
  assert.equal(retry.deliveryTask.id, 10)
  assert.equal(db.rows[0].payload.ceiling, 1)
  await updateInactivityContact(db, retry, { message_id: "saved", conversation_id: "fixture-chat", candidate: null, lease_token: null, lease_kind: null })
  assert.equal((await reserveInactivityContact(db, task, ceiling)).messageId, "saved")
})

test("unknown abandoned delivery stops; expired/night content is never reused", async () => {
  const db = ledgerFixture()
  const r = await reserveInactivityContact(db, task, ceiling)
  await persistInactivityCandidate(db, r, good, ceiling)
  assert.equal((await reserveInactivityContact(db, task, new Date(ceiling.getTime() + 16 * 60000))).reason, "inactivity_delivery_outcome_unknown")
  await releaseInactivityContact(db, r)
  const expired = await reserveInactivityContact(db, task, new Date(ceiling.getTime() + 31 * 60000))
  assert.equal(expired.generation, null)
  const nightDb = ledgerFixture()
  const late = new Date("2026-01-01T15:29:00Z")
  const lateReservation = await reserveInactivityContact(nightDb, task, late)
  await persistInactivityCandidate(nightDb, lateReservation, good, late)
  assert.equal(nightDb.rows[0].payload.candidate.valid_until, "2026-01-01T15:30:00.000Z")
})

test("schema supports ledger identity; ledger is never a runnable pending task", () => {
  const sql = readFileSync("supabase_xiaoc_proactive_tasks.sql", "utf8")
  assert.match(sql, /unique \(user_id, type, source_type, source_id\)/)
  assert.match(sql, /type text not null,/)
  assert.equal(INACTIVITY_BUDGET_TYPE, "inactivity_contact_budget")
  const source = readFileSync("api/memory.js", "utf8")
  assert.match(source, /\.eq\("status", "pending"\)/)
  assert.match(source, /inactivity_contact_budget_blocked/)
  assert.match(source, /generation = contactReservation\?\.generation \|\|/)
})

test("all prompt templates, Persona and generation settings remain byte-for-byte unchanged", () => {
  const source = readFileSync("api/memory.js", "utf8")
  const before = execFileSync("git", ["show", "HEAD:api/memory.js"], { encoding: "utf8" })
  const prompts = s => s.match(/`(?:\\.|[^`\\])*`/gs) || []
  assert.deepEqual(prompts(source), prompts(before))
  for (const file of ["prompt/system.md", "prompt/relationship.md", "lib/aiConfig.js", "api/chat.js"]) {
    assert.equal(withoutModelMigration(readFileSync(file, "utf8")), withoutModelMigration(execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" })))
  }
  const generation = readFileSync("lib/inactivityGeneration.js", "utf8")
  const originalGeneration = execFileSync("git", ["show", "HEAD:lib/inactivityGeneration.js"], { encoding: "utf8" })
  assert.equal(generation, originalGeneration)
})

test("reconciliation cannot revive an exhausted latest silence window", async () => {
  const source = readFileSync("api/memory.js", "utf8")
  const body = source.slice(source.indexOf("async function reconcileInactivityLifecycle("), source.indexOf("async function consumePendingInactivityWithProactiveMessage("))
  let reads = 0
  const latest = { id: "fixture-anchor", role: "user", conversation_id: "fixture-chat", created_at: task.payload.silence_anchor_at }
  const db = { from(table) {
    const q = { select() { return q }, eq() { return q }, in() { return q }, order() { return q },
      limit() { return table === "messages" ? q : Promise.resolve({ data: [], error: null }) },
      maybeSingle: async () => { reads++; return { data: latest, error: null } },
      upsert() { throw new Error("must not recreate") } }
    return q
  } }
  const run = vm.runInNewContext(`${body}\nreconcileInactivityLifecycle`, {
    supabase: db, getCurrentInactivityReachOutMode: async () => "normal",
    readInactivityBudget: async () => ({ id: 1, payload: { ceiling: 2 } }), getInactivitySoftFallbackAt,
  })
  assert.equal((await run({ userId: task.user_id, now: ceiling })).reason, "inactivity_contact_budget_blocked")
  assert.equal(reads, 1)
})

function executor({ reject = false, failure = null, advance = false } = {}) {
  const db = ledgerFixture()
  const ledgerFrom = db.from
  db.from = table => {
    if (table !== "messages") return ledgerFrom(table)
    const q = { select() { return q }, eq() { return q }, in() { return q }, order() { return q }, limit() { return q },
      maybeSingle: async () => ({ data: { id: advance ? "new-anchor" : task.payload.silence_anchor_message_id }, error: null }) }
    return q
  }
  let generated = 0, saves = 0
  const source = readFileSync("api/memory.js", "utf8")
  const body = source.slice(source.indexOf("async function executeProactiveTask("), source.indexOf("async function checkPendingProactiveTasks("))
  const run = vm.runInNewContext(`${body}\nexecuteProactiveTask`, {
    supabase: db, WEATHER_SHADOW_TASK_TYPE: "weather", PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE: "attention", BP1_CACHE_KEEPALIVE_TASK_TYPE: "keepalive",
    isProactiveQuietHours: () => false, validateInactivityReachOutTask: async () => ({ allowed: true }),
    getProactiveMessageCooldown: async () => null, getRecentInactivityContext: async () => ({ messages: [] }),
    getInactivitySilenceState: t => getInactivitySilenceState(t, ceiling), planInactivityReconsideration,
    reserveInactivityContact: (c, t) => reserveInactivityContact(c, t, ceiling),
    persistInactivityCandidate: (c, r, g) => persistInactivityCandidate(c, r, g, ceiling),
    releaseInactivityContact, updateInactivityContact,
    getInactivitySoftFallbackAt,
    generateInactivityReachOutMessage: async () => { generated++; return reject ? declined : good },
    hasConversationAdvancedSinceInactivityAnchor: (_task, latest) => latest.id !== task.payload.silence_anchor_message_id,
    getLastConversationId: async () => task.conversation_id,
    saveProactiveMessage: async ({ task: delivery }) => {
      assert.equal(delivery.id, task.id)
      saves++
      if (saves === 1 && failure) throw Object.assign(new Error("fixture delivery failure"), failure)
      return "saved-message"
    },
    enqueueNextInactivityReachOutTask: async () => ({ id: "next-task", due_at: "next-due" }),
  })
  return { db, run: t => run(t || task), counts: () => ({ generated, saves }) }
}

test("real executor caps repeated ceiling rejection, including a recreated task", async () => {
  const f = executor({ reject: true })
  assert.equal((await f.run()).deferred, true)
  assert.equal((await f.run()).deferred, true)
  for (let i = 0; i < 10; i++) assert.equal((await f.run({ ...task, id: 100 + i })).skipped, true)
  assert.deepEqual(f.counts(), { generated: 2, saves: 0 })
})

test("real executor reuses accepted content after known database rejection and continues lifecycle", async () => {
  const f = executor({ failure: { code: "53300" } })
  const first = await f.run()
  assert.equal(first.reason, "inactivity_delivery_retry_cached_content")
  const second = await f.run()
  assert.equal(second.messageId, "saved-message")
  assert.equal(second.payload.continuation_task_id, "next-task")
  assert.deepEqual(f.counts(), { generated: 1, saves: 2 })
})

test("real executor does not regenerate or resend when insert outcome is unknown", async () => {
  const f = executor({ failure: {} })
  assert.equal((await f.run()).reason, "inactivity_delivery_outcome_unknown")
  assert.equal((await f.run()).reason, "inactivity_delivery_outcome_unknown")
  assert.deepEqual(f.counts(), { generated: 1, saves: 1 })
})

test("new user activity cancels a generated stale contact without sending", async () => {
  const f = executor({ advance: true })
  assert.equal((await f.run()).skipped, true)
  assert.deepEqual(f.counts(), { generated: 1, saves: 0 })
})

const softRejected = {
  skipped: true, content: null, softFallbackContent: "Synthetic complete contact? Another question?",
  diagnostics: { should_send: true, skip_reason: "too_many_questions" },
}

async function fourAttempts(db) {
  for (const at of [ordinary, ordinary, ceiling, ceiling]) {
    const reservation = await reserveInactivityContact(db, task, at)
    await persistInactivityCandidate(db, reservation, softRejected, at)
  }
}

test("soft fallback requires the full 12 hours and four consumed attempts, with no fifth model allowance", async () => {
  const db = ledgerFixture()
  await fourAttempts(db)
  const early = await reserveInactivityContact(db, task, ceiling)
  assert.equal(early.reason, "inactivity_soft_fallback_waits_for_ceiling")
  assert.equal(early.dueAt, "2026-01-01T12:00:00.000Z")
  const ready = await reserveInactivityContact(db, task, new Date(early.dueAt))
  assert.equal(ready.generation.content, softRejected.softFallbackContent)
  assert.equal(ready.generation.diagnostics.fallback_applied, true)
  assert.equal(db.rows[0].payload.fallback_used, true)
  assert.equal(db.rows[0].payload.ordinary + db.rows[0].payload.ceiling, 4)
})

test("parallel fallback claims authorize one delivery, never two fallback promotions", async () => {
  const db = ledgerFixture()
  await fourAttempts(db)
  const results = await Promise.all([reserveInactivityContact(db, task, new Date("2026-01-01T12:00:00Z")),
    reserveInactivityContact(db, { ...task, id: 88 }, new Date("2026-01-01T12:00:00Z"))])
  assert.equal(results.filter(r => r.generation).length, 1)
  const winner = results.find(r => r.generation)
  await updateInactivityContact(db, winner, { message_id: "fallback-saved", lease_token: null, lease_kind: null, candidate: null })
  assert.equal((await reserveInactivityContact(db, task, new Date("2026-01-01T12:01:00Z"))).messageId, "fallback-saved")
})

test("no fallback for hard failures, empty output, refusal, expired content or insufficient attempts", async () => {
  const checks = { internalLanguage: false, timeInappropriate: false, temporallyUnsupported: false, factualGrounded: true }
  const decision = { parseFailed: false, shouldSend: true, selfContinuity: true, topicState: "uncertain", shouldReferenceTopic: false }
  assert.equal(canUseInactivitySoftFallback(decision, "too_many_questions", "Complete content.", checks), true)
  assert.equal(canUseInactivitySoftFallback(decision, "missing_contact_motivation", "Complete content.", checks), true)
  for (const reason of ["model_declined", "empty_output", "invalid_structured_output", "temporally_unsupported", "time_inappropriate", "internal_language", "factual_grounding:unsupported"]) {
    assert.equal(canUseInactivitySoftFallback(decision, reason, "Complete content.", checks), false)
  }
  for (const overrides of [{ factualGrounded: false }, { internalLanguage: true }, { temporallyUnsupported: true }, { timeInappropriate: true }]) {
    assert.equal(canUseInactivitySoftFallback(decision, "too_many_questions", "Complete content.", { ...checks, ...overrides }), false)
  }
  assert.equal(canUseInactivitySoftFallback({ ...decision, shouldSend: false }, "too_many_questions", "Complete content.", checks), false)
  assert.equal(canUseInactivitySoftFallback(decision, "too_many_questions", "", checks), false)
  const db = ledgerFixture()
  await fourAttempts(db)
  assert.equal((await reserveInactivityContact(db, task, new Date("2026-01-01T12:11:00Z"))).blocked, true)
  assert.equal(getInactivitySoftFallbackAt({ ordinary: 0, ceiling: 2, soft_candidate: db.rows[0].payload.soft_candidate }, task.payload.silence_anchor_at, ceiling), null)
})

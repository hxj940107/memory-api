import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"
import { readFileSync } from "node:fs"
import { capInactivityOpportunityAtCeiling, getInactivitySilenceState } from "../lib/inactivityReachOut.js"

const memory = readFileSync("api/memory.js", "utf8")
const chat = readFileSync("api/chat.js", "utf8")
function section(source, start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))) }
const local = date => {
  const d = new Date(new Date(date).getTime() + 8 * 3600000)
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() }
}
const quiet = date => { const p = local(date); return p.hour < 7 || (p.hour === 23 && p.minute >= 30) }
const morning = date => {
  const p = local(date)
  return new Date(Date.parse(`${p.date}T07:00:00+08:00`) + (p.hour >= 23 ? 86400000 : 0)).toISOString()
}

function executor(at, { crossDuringGeneration = false, crossDuringSave = false, advanced = false } = {}) {
  let clock = Date.parse(at)
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])) } static now() { return clock } }
  const calls = { generation: 0, save: 0, latest: 0, context: 0 }
  const task = { id: "task", user_id: "user", type: "inactivity_reach_out", payload: {
    silence_anchor_message_id: "anchor", silence_anchor_at: "2026-10-20T06:00:00Z" } }
  const context = {
    Date: Clock, WEATHER_SHADOW_TASK_TYPE: "weather", PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE: "attention", BP1_CACHE_KEEPALIVE_TASK_TYPE: "cache",
    isProactiveQuietHours: (date = new Clock()) => quiet(date), getNextProactiveMorning: (date = new Clock()) => morning(date),
    validateInactivityReachOutTask: async () => ({ allowed: true }), getProactiveMessageCooldown: async () => null,
    getInactivitySilenceState, getRecentInactivityContext: async () => { calls.context++; return { messages: ["latest context"] } },
    generateInactivityReachOutMessage: async ({ recentContext }) => {
      calls.generation++; assert.deepEqual(recentContext.messages, ["latest context"])
      if (crossDuringGeneration) clock = Date.parse("2026-10-21T15:30:00Z")
      return { content: "freshly generated", diagnostics: {} }
    },
    supabase: { from() { const q = { select() { return q }, eq() { return q }, in() { return q }, order() { return q }, limit() { return q },
      maybeSingle: async () => { calls.latest++; return { data: { id: advanced ? "new-user" : "anchor" } } } }; return q } },
    hasConversationAdvancedSinceInactivityAnchor: (t, latest) => latest.id !== t.payload.silence_anchor_message_id,
    getLastConversationId: async () => "chat",
    saveProactiveMessage: async () => { if (crossDuringSave) throw Object.assign(new Error("quiet_hours"), { code: "INACTIVITY_QUIET_HOURS" }); calls.save++; return "sent" },
    enqueueNextInactivityReachOutTask: async () => null,
  }
  const run = vm.runInNewContext(section(memory, "async function executeProactiveTask(", "async function checkPendingProactiveTasks(") + "\nexecuteProactiveTask", context)
  return { run: () => run(task), calls, task }
}

test("ceiling cannot bypass quiet hours at 23:30, midnight, or 06:59; no generation", async () => {
  for (const at of ["2026-10-21T23:30:00+08:00", "2026-10-22T00:00:00+08:00", "2026-10-22T06:59:00+08:00"]) {
    const f = executor(at)
    const result = await f.run()
    assert.equal(result.deferred, true)
    assert.equal(result.dueAt, "2026-10-21T23:00:00.000Z")
    assert.equal(f.calls.generation, 0); assert.equal(f.calls.save, 0)
    assert.equal(f.task.payload.silence_anchor_at, "2026-10-20T06:00:00Z")
  }
})

test("07:00 uses fresh context and exactly one existing generation call", async () => {
  const f = executor("2026-10-22T07:00:00+08:00")
  await f.run()
  assert.equal(f.calls.context, 1); assert.equal(f.calls.generation, 1); assert.equal(f.calls.save, 1)
})

test("crossing 23:30 during generation discards content and defers without saving", async () => {
  const f = executor("2026-10-21T23:29:00+08:00", { crossDuringGeneration: true })
  assert.equal((await f.run()).reason, "quiet_hours")
  assert.equal(f.calls.generation, 1); assert.equal(f.calls.save, 0)
})

test("last-moment persistence quiet guard returns task to pending without stale content", async () => {
  const f = executor("2026-10-21T23:29:00+08:00", { crossDuringSave: true })
  const result = await f.run()
  assert.equal(result.deferred, true); assert.equal(result.reason, "quiet_hours")
  assert.equal(result.content, undefined); assert.equal(result.payload, undefined)
  assert.equal(f.calls.save, 0)
})

test("user returning before send invalidates the old silence window", async () => {
  const f = executor("2026-10-22T07:00:00+08:00", { advanced: true })
  assert.equal((await f.run()).skipped, true); assert.equal(f.calls.save, 0)
})

test("chat scheduling caps deadline before morning adjustment, never pulls it back into night", () => {
  const at = Date.parse("2026-10-20T22:00:00+08:00")
  class Clock extends Date { static now() { return at } }
  const run = vm.runInNewContext(section(chat, "function getInactivityReachOutDueAt(", "async function enqueueInactivityReachOutTask(") + "\ngetInactivityReachOutDueAt", {
    Date: Clock, getInactivityReachOutDelayMinutes: () => 600, capInactivityOpportunityAtCeiling,
    deferOutOfQuietHours: d => quiet(d) ? morning(d) : d.toISOString(),
  })
  assert.equal(run("open", "normal", "2026-10-20T14:00:00+08:00"), "2026-10-20T23:00:00.000Z")
})

test("morning randomization remains 07:00–07:30 Shanghai time", () => {
  for (const value of [0, 0.99999]) {
    const run = vm.runInNewContext(section(memory, "function getNextProactiveMorning(", "function parseMomentDecision(") + "\ngetNextProactiveMorning", {
      Date, Math: { random: () => value, floor: Math.floor }, getMomentLocalTime: local,
    })
    assert.equal(run(new Date("2026-10-20T23:30:00+08:00")), value === 0 ? "2026-10-20T23:00:00.000Z" : "2026-10-20T23:30:00.000Z")
  }
})

test("worker no longer exempts inactivity ceiling; persistence checks before insert", async () => {
  const exemptions = section(memory, "  const quietHourExempt =", "  const quietDeferred =")
  assert.doesNotMatch(exemptions, /inactivity_reach_out|ceiling_contact_required/)
  // Extract to the next function, skipping the opening declaration itself.
  const start = memory.indexOf("async function saveProactiveMessage(")
  const body = memory.slice(start, memory.indexOf("\nasync function ", start + 1))
  let writes = 0
  const run = vm.runInNewContext(body + "\nsaveProactiveMessage", {
    isProactiveQuietHours: () => true, supabase: { from() { writes++; throw new Error("must not insert") } },
  })
  await assert.rejects(run({ user_id: "user", task: { type: "inactivity_reach_out" } }), /quiet_hours/)
  assert.equal(writes, 0)
})

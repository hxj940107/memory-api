import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { USER_MOMENT_AUTHORS, MOMENT_ACTIVITY_COOLDOWN_MS, getUserMomentActivityDeferral } from "../lib/inactivityMomentActivity.js"
import { getInactivitySilenceState, hasConversationAdvancedSinceInactivityAnchor, planInactivityReconsideration } from "../lib/inactivityReachOut.js"

const at = "2030-01-01T03:00:00Z"
const moment = { id: "synthetic-moment", user_id: "owner", author: USER_MOMENT_AUTHORS[0], created_at: "2030-01-01T02:30:00Z" }
const options = { userId: "owner", scheduledAt: "2030-01-01T01:00:00Z", now: at, deadlineAt: "2030-01-01T12:40:00Z" }
const defer = (m = moment, o = {}) => getUserMomentActivityDeferral(m, { ...options, ...o })

for (const author of ["小C", null, "unknown-synthetic-author", "", "user"]) {
  test(`unconfirmed author ${String(author)} cannot defer`, () => assert.equal(defer({ ...moment, author }), null))
}
test("both explicit client default authors may defer", () => {
  for (const author of USER_MOMENT_AUTHORS) assert.equal(defer({ ...moment, author }), "2030-01-01T04:00:00.000Z")
})
test("repeated and concurrent checks retain a fixed expiry", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve(defer())))
  assert.equal(new Set(results).size, 1)
  assert.equal(defer(moment, { now: "2030-01-01T03:55:00Z" }), results[0])
  assert.equal(defer(moment, { now: results[0] }), null)
})
test("new distinct moment has its own bounded expiry", () => {
  assert.equal(defer({ ...moment, id: "new", created_at: at }), "2030-01-01T04:30:00.000Z")
  assert.equal(defer({ ...moment, created_at: "2030-01-01T01:00:00Z" }), null)
})
test("cross-owner, absent, future and invalid data fail closed", () => {
  for (const m of [null, { ...moment, user_id: "other" }, { ...moment, created_at: "bad" }, { ...moment, created_at: "2030-01-02T00:00:00Z" }]) assert.equal(defer(m), null)
})
test("ceiling caps expiry and bypasses activity at deadline", () => {
  assert.equal(defer(moment, { deadlineAt: "2030-01-01T03:15:00Z" }), "2030-01-01T03:15:00.000Z")
  assert.equal(defer(moment, { deadlineAt: at }), null)
})

const source = readFileSync("api/memory.js", "utf8")
const validator = source.slice(source.indexOf("async function validateInactivityReachOutTask("), source.indexOf("async function getProactiveMessageCooldown("))
async function validate(m, { advanced = false, mode = "frequent" } = {}) {
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [at])) } static now() { return Date.parse(at) } }
  const filters = []
  const client = { from(table) {
    const q = { select() { return q }, eq(...args) { filters.push([table, "eq", ...args]); return q },
      in(...args) { filters.push([table, "in", ...args]); return q }, gt() { return q }, gte() { return q }, lte() { return q }, order() { return q }, limit() { return q },
      async maybeSingle() { return { data: table === "user_state" ? { inactivity_reach_out_mode: mode }
        : table === "messages" ? { id: advanced ? "new" : "anchor" } : table === "moment_entries" ? m : null } } }
    return q
  } }
  const run = vm.runInNewContext(validator + "\nvalidateInactivityReachOutTask", {
    Date: Clock, supabase: client, getInactivitySilenceState, hasConversationAdvancedSinceInactivityAnchor,
    DEFAULT_INACTIVITY_REACH_OUT_MODE: "normal", normalizeInactivityReachOutMode: x => x,
    USER_MOMENT_AUTHORS, MOMENT_ACTIVITY_COOLDOWN_MS, getUserMomentActivityDeferral,
  })
  const result = await run({ user_id: "owner", payload: { silence_anchor_message_id: "anchor", silence_anchor_at: options.scheduledAt, scheduled_at: options.scheduledAt } })
  return { result, filters }
}
test("actual validator excludes XiaoC even if query mock returns him", async () => {
  const { result, filters } = await validate({ ...moment, author: "小C" })
  assert.equal(result.allowed, true)
  assert.ok(filters.some(f => f[0] === "moment_entries" && f[1] === "in" && f[2] === "author"))
})
test("actual validator propagates fixed dueAt for confirmed user", async () => {
  const { result } = await validate(moment)
  assert.equal(result.deferred, true)
  assert.equal(result.dueAt, defer())
})
test("no moment preserves eligibility, new chat and opt-out still block", async () => {
  assert.equal((await validate(null)).result.allowed, true)
  assert.equal((await validate(null, { advanced: true })).result.allowed, false)
  assert.equal((await validate(null, { mode: "off" })).result.allowed, false)
})
test("executor consumes gate expiry rather than rolling reconsideration time", () => {
  assert.ok(source.includes("new Date(validation.dueAt || reconsideration.due_at)"))
})

test("real executor defers to fixed activity expiry without generation or delivery", async () => {
  const body = source.slice(source.indexOf("async function executeProactiveTask("), source.indexOf("async function checkPendingProactiveTasks("))
  const task = { id: 100, type: "inactivity_reach_out", user_id: "owner", payload: {
    silence_anchor_at: options.scheduledAt, silence_anchor_message_id: "anchor",
  } }
  let paid = 0
  const run = vm.runInNewContext(body + "\nexecuteProactiveTask", {
    WEATHER_SHADOW_TASK_TYPE: "weather", PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE: "attention", BP1_CACHE_KEEPALIVE_TASK_TYPE: "cache",
    isProactiveQuietHours: () => false,
    validateInactivityReachOutTask: async () => ({ allowed: false, deferred: true, dueAt: defer(), reason: "user_moment_activity" }),
    planInactivityReconsideration,
    reserveInactivityContact: async () => { paid++; throw new Error("must not reserve") },
    generateInactivityReachOutMessage: async () => { paid++; throw new Error("must not generate") },
    saveProactiveMessage: async () => { throw new Error("must not send") },
  })
  for (let i = 0; i < 3; i++) {
    const result = await run(task)
    assert.equal(result.deferred, true)
    assert.equal(result.dueAt, defer())
    assert.equal(result.payload.silence_anchor_at, task.payload.silence_anchor_at)
  }
  assert.equal(paid, 0)
})

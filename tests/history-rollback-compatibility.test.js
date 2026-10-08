import assert from "node:assert/strict"
import test from "node:test"
import { createLatestHistoryReader } from "../mobile/XiaoC/src/lib/historyLatest.ts"

test("new backend uses only latest; rollback uses legacy list then retries after cache expiry", async () => {
  let clock = 0, oldBackend = false
  const read = createLatestHistoryReader(() => clock)
  const calls = []
  const fetchAction = async action => {
    calls.push(action)
    if (oldBackend && action === "latest") throw Object.assign(new Error("unsupported history action"), { status: 400 })
    return [{ id: "proactive", created_at: "2026-10-08T07:00:00Z", ...(action === "list" ? { content: "offline", metadata: { imageUrl: "A".repeat(500000) } } : {}) }]
  }
  await read(fetchAction); assert.deepEqual(calls, ["latest"])
  oldBackend = true; calls.length = 0
  const rows = await read(fetchAction)
  assert.deepEqual(calls, ["latest", "list"])
  assert.deepEqual(rows, [{ id: "proactive", created_at: "2026-10-08T07:00:00Z" }])
  calls.length = 0; clock = 30000; await read(fetchAction); assert.deepEqual(calls, ["list"])
  oldBackend = false; clock = 60000; calls.length = 0
  await read(fetchAction); assert.deepEqual(calls, ["latest"])
})

test("rollback to an empty legacy conversation still returns an empty list", async () => {
  const read = createLatestHistoryReader()
  assert.deepEqual(await read(async action => {
    if (action === "latest") throw Object.assign(new Error("unsupported history action"), { status: 400 })
    return []
  }), [])
})

for (const [status, message] of [[401, "Unauthorized"], [403, "owner mismatch"], [400, "invalid before_id"], [500, "unsupported history action"], [503, "provider unavailable"]]) {
  test(`no fallback for ${status} ${message}`, async () => {
    const read = createLatestHistoryReader(); let calls = 0
    const error = Object.assign(new Error(message), { status })
    await assert.rejects(read(async () => { calls++; throw error }), e => e === error)
    assert.equal(calls, 1)
  })
}

test("legacy read failures propagate and are never retried in a loop", async () => {
  const read = createLatestHistoryReader(); const calls = []
  await assert.rejects(read(async action => {
    calls.push(action)
    throw Object.assign(new Error(action === "latest" ? "unsupported history action" : "Request timeout"), { status: action === "latest" ? 400 : 503 })
  }), /Request timeout/)
  assert.deepEqual(calls, ["latest", "list"])
})

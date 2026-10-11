import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { getLatestHistoryMessage } from "../lib/latestHistory.js"
import { startHistoryPolling } from "../mobile/XiaoC/src/lib/historyPolling.ts"
import { createLatestHistoryReader } from "../mobile/XiaoC/src/lib/historyLatest.ts"
import { requireRequestIdentity as enforceRequestIdentity } from "../lib/requestIdentity.js"
import { queryFixture } from "./helpers/queryFixture.js"

function historyHandler(client, allowed = true, identityOptions = null) {
  const source = readFileSync("api/history.js", "utf8")
    .replace(/^import .*\n/gm, "")
    .replace(/const supabase = createClient\([\s\S]*?\)\n/, "")
    .replace("export default async function handler", "async function handler")
  return vm.runInNewContext(`${source}\nhandler`, {
    supabase: client, getLatestHistoryMessage,
    requireRequestIdentity: async (_req, res) => {
      if (identityOptions) return enforceRequestIdentity(_req, res, identityOptions)
      if (!allowed) res.status(401).json({ error: "Unauthorized" })
      return allowed
    }, console,
  })
}
async function request(client, action, allowed = true) {
  let status, body
  const res = { status(s) { status = s; return this }, json(b) { body = b } }
  await historyHandler(client, allowed)({ method: "GET", query: { user_id: "user", conversation_id: "c", ...(action ? { action } : {}) } }, res)
  return { status, body }
}

test("latest is bounded, owner scoped, deterministic and excludes a large picture", async () => {
  const rows = [
    { id: "a", user_id: "user", conversation_id: "c", created_at: "2026-10-08T00:00:00Z", role: "user", content: "photo", metadata: { imageUrl: "data:image/jpeg;base64," + "A".repeat(500_000) } },
    { id: "b", user_id: "user", conversation_id: "c", created_at: "2026-10-08T00:00:00Z", role: "assistant", content: "proactive", metadata: { proactive: true } },
    { id: "z", user_id: "another-owner", conversation_id: "c", created_at: "2026-10-09T00:00:00Z" },
    { id: "y", user_id: "user", conversation_id: "other", created_at: "2026-10-09T00:00:00Z" },
  ]
  const client = queryFixture({ messages: rows })
  const result = await request(client, "latest")
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, [{ id: "b", created_at: rows[1].created_at }])
  assert.equal(client.reads[0].fields, "id,created_at")
  assert.equal((await request(queryFixture({ messages: [] }), "latest")).body.length, 0)
  const legacy = await request(queryFixture({ messages: rows }))
  assert.equal(legacy.body.length, 2)
  assert.equal(legacy.body[0].metadata.imageUrl, rows[0].metadata.imageUrl)
  assert.equal(legacy.body[1].metadata.proactive, true)
  const denied = queryFixture({ messages: rows })
  assert.equal((await request(denied, "latest", false)).status, 401)
  assert.equal(denied.reads.length, 0)
})

test("latest runs through the real identity guard before any message read", async () => {
  const owner = "94000000-0000-4000-8000-000000000001"
  const token = "fixture-app-token-" + "a".repeat(40)
  const options = {
    env: { PRIVATE_IDENTITY_APP_TOKEN_FALLBACK_ENABLED: "true", XIAOC_APP_TOKEN: token, XIAOC_PRIVATE_AUTH_USER_UUID: owner },
    serviceClient: queryFixture({ companion_instances: [{ user_id: owner, lifecycle_status: "active" }] }),
  }
  for (const [query, headers, expected] of [
    [{ user_id: "user", conversation_id: "c", action: "latest" }, {}, 401],
    [{ user_id: "other-owner", conversation_id: "c", action: "latest" }, { "x-xiaoc-app-token": token }, 403],
    [{ user_id: "user", user_uuid: owner, conversation_id: "c", action: "latest" }, { "x-xiaoc-app-token": token }, 400],
    [{ user_id: "user", conversation_id: "c", action: "latest" }, { "x-xiaoc-app-token": token }, 200],
  ]) {
    const db = queryFixture({ messages: [{ id: "m", user_id: "user", conversation_id: "c", created_at: "2026-10-08T07:00:00Z" }] })
    let status
    const res = { status(value) { status = value; return this }, json() {} }
    await historyHandler(db, true, options)({ method: "GET", url: "/api/history", query, headers }, res)
    assert.equal(status, expected)
    assert.equal(db.reads.length, expected === 200 ? 1 : 0)
  }
})

test("one timer survives foreground changes, stops in background and is removed on blur", () => {
  const timers = new Map(); let next = 1, listener, refreshed = 0
  const appState = { currentState: "active", addEventListener(_name, fn) { listener = fn; return { remove() { listener = null } } } }
  const stop = startHistoryPolling({ appState, refresh: () => refreshed++, setTimer(fn, delay) { assert.equal(delay, 30_000); const id = next++; timers.set(id, fn); return id }, clearTimer(id) { timers.delete(id) } })
  assert.equal(timers.size, 1)
  listener("active"); listener("active")
  assert.equal(timers.size, 1)
  listener("background"); assert.equal(timers.size, 0)
  listener("inactive"); assert.equal(timers.size, 0)
  listener("active"); assert.equal(timers.size, 1)
  stop(); assert.equal(timers.size, 0); assert.equal(listener, null)
  assert.equal(refreshed, 3)
})

test("sync keeps in-flight protection and ignores responses for changed chat or lost focus", async () => {
  const source = readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")
  const section = source.slice(source.indexOf("const refreshIfCloudHistoryChanged ="), source.indexOf("\n  useFocusEffect(", source.indexOf("const refreshIfCloudHistoryChanged =")))
  const fn = section.replace("const refreshIfCloudHistoryChanged =", "const refresh =").replace(/apiJson<Pick<HistoryItem, "id" \| "created_at">\[\]>/, "apiJson")
  let release, requests = 0, restores = 0
  const ctx = { conversationIdRef: { current: "c" }, historyLocationModeRef: { current: false }, historySyncFocusedRef: { current: true }, historyRefreshInFlightRef: { current: false }, AppState: { currentState: "active" }, APP_USER_ID: "user", latestCloudMessageIdRef: { current: "old" }, skipNextMessageAutoScrollRef: { current: false }, console, apiJson: async (_path, opts) => { assert.equal(opts.query.action, "latest"); requests++; return new Promise(resolve => { release = resolve }) }, restoreConversation: async () => restores++ }
  ctx.latestHistoryReaderRef = { current: createLatestHistoryReader() }
  const refresh = vm.runInNewContext(`${fn}\nrefresh`, ctx)
  const first = refresh(); await refresh(); assert.equal(requests, 1)
  release([{ id: "proactive" }]); await first; assert.equal(restores, 1)
  const second = refresh(); ctx.conversationIdRef.current = "new-chat"; release([{ id: "new" }]); await second; assert.equal(restores, 1)
  const third = refresh(); ctx.historySyncFocusedRef.current = false; release([{ id: "new" }]); await third; assert.equal(restores, 1)
  ctx.historySyncFocusedRef.current = true; ctx.AppState.currentState = "background"; await refresh(); assert.equal(requests, 3)
  ctx.AppState.currentState = "active"
  const concurrentSend = refresh()
  ctx.latestCloudMessageIdRef.current = "sent-reply"
  release([{ id: "sent-reply" }]); await concurrentSend
  assert.equal(restores, 1)
  assert.equal(ctx.historyRefreshInFlightRef.current, false)
})

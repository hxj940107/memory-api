import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import vm from "node:vm"
import { parseActivityLog, handleDeviceActivityUpload } from "../lib/deviceActivityUpload.js"

const now = Date.parse("2026-10-26T15:00:00Z")
const line = "2026-10-26 22:52:30 | 抖音 | 打开"
const env = {
  XIAOC_ACTIVITY_UPLOAD_ENABLED: "true",
  XIAOC_ACTIVITY_UPLOAD_TOKEN: "a".repeat(40),
  XIAOC_PRIVATE_AUTH_USER_UUID: "11111111-1111-4111-8111-111111111111",
}
async function request({ method = "POST", body = { log: line }, token = env.XIAOC_ACTIVITY_UPLOAD_TOKEN, config = env, result = { data: { status: "accepted" } } } = {}) {
  const calls = []
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, status(s) { this.code = s; return this }, json(b) { this.body = b; return this } }
  const client = { async rpc(name, args) { calls.push({ name, args }); return result } }
  await handleDeviceActivityUpload({ method, body, headers: { "x-xiaoc-activity-token": token } }, res, { client, env: config, now })
  return { ...res, calls }
}

test("logs use Shanghai time, accept both separators and dedupe repeated batches", () => {
  const parsed = parseActivityLog(`${line}\n${line.replaceAll(" | ", "｜")}\n2026-10-26 22:52:46 | 抖音 | 离开`, now)
  assert.equal(parsed.events.length, 2)
  assert.equal(parsed.events[0].occurred_at, "2026-10-26T14:52:30.000Z")
  assert.equal(parsed.events[0].event_id, parseActivityLog(line, now).events[0].event_id)
  assert.equal(parsed.events[1].kind, "left")
})
test("consecutive leave signals remain events rather than fabricated duration", () => {
  assert.equal(parseActivityLog("2026-10-26 22:52:46 | 淘宝 | 离开\n2026-10-26 22:52:58 | 淘宝 | 离开", now).events.length, 2)
})
test("bad dates, unknown apps, future data and oversized batches fail atomically", () => {
  for (const log of [line.replace("抖音", "微信"), line + "\ninvalid", line.replace("10-26", "02-30"), line.replace("22:52", "23:52"), Array(301).fill(line).join("\n"), "x".repeat(65537)]) {
    assert.throws(() => parseActivityLog(log, now))
  }
  assert.equal(parseActivityLog(line.replace("10-26", "10-01"), now).expired, 1)
})
test("disabled, wrong credential, wrong method and client ownership never write", async () => {
  for (const [args, code] of [
    [{ config: { ...env, XIAOC_ACTIVITY_UPLOAD_ENABLED: "false" } }, 503],
    [{ token: "wrong" }, 401], [{ method: "GET" }, 405],
    [{ body: { log: line, user_id: "other" } }, 400],
    [{ config: { ...env, XIAOC_PRIVATE_AUTH_USER_UUID: "" } }, 503],
    [{ config: { ...env, XIAOC_APP_TOKEN: env.XIAOC_ACTIVITY_UPLOAD_TOKEN } }, 503],
  ]) {
    const response = await request(args)
    assert.equal(response.code, code)
    assert.equal(response.calls.length, 0)
  }
})
test("acceptance acknowledges only after owner-bound storage; throttle and failure do not ack", async () => {
  const accepted = await request()
  assert.equal(accepted.code, 200)
  assert.equal(accepted.calls[0].args.p_owner, env.XIAOC_PRIVATE_AUTH_USER_UUID)
  assert.equal(accepted.body.acknowledged_events, 1)
  const throttle = await request({ result: { data: { status: "throttled", retry_after_seconds: 123 } } })
  assert.equal(throttle.code, 429)
  assert.equal(throttle.headers["Retry-After"], "123")
  const failed = await request({ result: { error: { code: "missing_rpc" } } })
  assert.equal(failed.code, 503)
  assert.equal(failed.body.status, undefined)
})
test("ingestion reuses one of twelve endpoints; special credential cannot enter other actions", () => {
  assert.equal(readdirSync("api").filter(s => s.endsWith(".js")).length, 12)
  const source = readFileSync("api/user-state.js", "utf8")
  assert.match(source, /if \(req.query\?\.action === ACTIVITY_UPLOAD_ACTION\)/)
  assert.ok(source.indexOf("return handleDeviceActivityUpload") < source.indexOf("if (!await requireRequestIdentity"))
})

test("actual endpoint dispatch never grants the activity credential access to other actions", async () => {
  const source = readFileSync("api/user-state.js", "utf8")
    .replace(/^import[\s\S]*?from "[^"]+"\n/gm, "")
    .replace("export default async function handler", "async function handler")
  let identityCalls = 0, uploadCalls = 0
  const handler = vm.runInNewContext(`${source}\nhandler`, {
    createClient: () => ({}), process: { env: {} },
    ACTIVITY_UPLOAD_ACTION: "upload-device-activity",
    handleDeviceActivityUpload: async () => { uploadCalls++ },
    requireRequestIdentity: async () => { identityCalls++; return null },
  })
  await handler({ query: { action: "upload-device-activity" }, method: "POST" }, {})
  assert.equal(uploadCalls, 1)
  for (const action of ["client-preferences", "favorites", "openrouter-credits", undefined]) {
    await handler({ query: { action }, method: "GET", headers: { "x-xiaoc-activity-token": env.XIAOC_ACTIVITY_UPLOAD_TOKEN } }, {})
  }
  await handler({ query: {}, body: { action: "upload-device-activity" }, method: "POST" }, {})
  assert.equal(identityCalls, 5)
  assert.equal(uploadCalls, 1)
})

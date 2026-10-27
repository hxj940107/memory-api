import { createHash, timingSafeEqual } from "node:crypto"
import { configuredPrivateAuthUserUuid } from "./requestIdentity.js"

export const ACTIVITY_UPLOAD_ACTION = "upload-device-activity"
const MAX_BYTES = 64 * 1024
const MAX_LINES = 300
const MAX_AGE_MS = 7 * 86400000
const APPS = new Map([["小红书", "xiaohongshu"], ["抖音", "douyin"], ["淘宝", "taobao"]])

function failure(code, status = 400) {
  return Object.assign(new Error(code), { code, status })
}

// Existing Shortcuts logs are wall-clock times in Asia/Shanghai, not server time.
export function parseActivityLog(log, now = Date.now()) {
  if (typeof log !== "string") throw failure("activity_log_required")
  if (Buffer.byteLength(log, "utf8") > MAX_BYTES) throw failure("activity_log_too_large", 413)
  const lines = log.replace(/^\uFEFF/, "").split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (!lines.length || lines.length > MAX_LINES) throw failure("activity_line_limit")
  const events = new Map()
  let expired = 0
  for (const line of lines) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s*[|｜]\s*(小红书|抖音|淘宝)\s*[|｜]\s*(打开|离开)$/)
    if (!match) throw failure("invalid_activity_line")
    const [, day, time, label, action] = match
    const timestamp = Date.parse(`${day}T${time}+08:00`)
    // Round-trip rejects dates such as February 30 that Date.parse normalizes.
    if (!Number.isFinite(timestamp)
      || new Date(timestamp + 8 * 3600000).toISOString().slice(0, 19) !== `${day}T${time}`
      || timestamp > now + 5 * 60000) throw failure("invalid_activity_time")
    if (timestamp < now - MAX_AGE_MS) { expired++; continue }
    const app = APPS.get(label)
    const kind = action === "打开" ? "opened" : "left"
    const occurred_at = new Date(timestamp).toISOString()
    const event_id = createHash("sha256").update(`${app}|${kind}|${occurred_at}`).digest("hex")
    events.set(event_id, { event_id, app, kind, occurred_at })
  }
  return { events: [...events.values()], expired, lineCount: lines.length }
}

export async function handleDeviceActivityUpload(req, res, { client, env = process.env, now = Date.now() }) {
  res.setHeader("Cache-Control", "no-store")
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST")
    return res.status(405).json({ error: "method_not_allowed" })
  }
  if (env.XIAOC_ACTIVITY_UPLOAD_ENABLED !== "true") return res.status(503).json({ error: "activity_upload_disabled" })
  const token = String(env.XIAOC_ACTIVITY_UPLOAD_TOKEN || "")
  const supplied = req.headers?.["x-xiaoc-activity-token"]
  if (token.length < 32 || [env.XIAOC_APP_TOKEN, env.CRON_SECRET, env.SUPABASE_SERVICE_ROLE_KEY].includes(token)) {
    return res.status(503).json({ error: "activity_token_not_configured" })
  }
  const digest = value => createHash("sha256").update(value).digest()
  if (typeof supplied !== "string" || supplied.length > 1024 || !timingSafeEqual(digest(token), digest(supplied))) {
    return res.status(401).json({ error: "invalid_activity_token" })
  }
  try {
    const owner = configuredPrivateAuthUserUuid(env)
    const body = req.body
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => !["log", "action"].includes(key))
      || (body.action !== undefined && body.action !== ACTIVITY_UPLOAD_ACTION)) throw failure("invalid_activity_body")
    const parsed = parseActivityLog(body.log, now)
    const { data, error } = await client.rpc("ingest_private_device_activity", {
      p_owner: owner, p_events: parsed.events,
    })
    if (error) {
      // Never log the body, headers, raw activity records or database error details.
      console.error("ACTIVITY_UPLOAD_FAILED", { code: String(error.code || "unknown") })
      return res.status(503).json({ error: "activity_storage_unavailable" })
    }
    if (data?.status === "throttled") {
      res.setHeader("Retry-After", String(data.retry_after_seconds || 300))
      return res.status(429).json({ error: "activity_upload_throttled", retry_after_seconds: data.retry_after_seconds || 300 })
    }
    if (data?.status !== "accepted") return res.status(503).json({ error: "activity_storage_unavailable" })
    return res.status(200).json({ status: "accepted", acknowledged_events: parsed.events.length, expired_lines: parsed.expired, received_lines: parsed.lineCount })
  } catch (error) {
    return res.status(error.status || 503).json({ error: error.code || "activity_upload_unavailable" })
  }
}

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { judgeMemory, XIAOC_MEMORY_GROUNDING_POLICY_VERSION } from "../lib/memoryJudge.js"
import { validateXiaoCMemoryNativeCaptureInput, runXiaoCMemoryNativeCapture } from "../lib/xiaocMemoryNativeCapture.js"
import { selectMemoryEventWindow, runMemoryEventCapture, reevaluateExpiredMemoryEvents, MEMORY_EVENT_WINDOW } from "../lib/memoryEventCapture.js"

const ids = [1, 2, 3, 4, 5].map(n => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`)
const env = { XIAOC_MEMORY_NATIVE_CAPTURE_ENABLED: "true" }
const at = "2026-01-01T10:00:00Z"
const message = (index, content, role = "user", extra = {}) => ({ id: ids[index], user_id: "fictional-owner",
  conversation_id: "fictional-chat", role, content, created_at: `2026-01-01T10:0${index}:00Z`, ...extra })
const announcement = message(0, "我为你准备了礼物，稍后揭晓")
const image = message(1, "", "user", { metadata: { imageDescription: "图片可能显示 example.invalid" } })
const reveal = message(2, "礼物是一个域名，名字是 lantern.example")
const source = m => ({ source_role: "user", source_message_id: m.id, evidence_text: m.content, evidence_type: "assertion" })
const saved = () => ({ action: "save", save: true, event_start_message_id: announcement.id,
  category: "relationship_memory", content: "她为我准备了礼物，揭晓是域名 lantern.example。",
  sources: [source(announcement), source(reveal)] })
const response = raw => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(raw) } }] }) })
const grounded = raw => ({ ...raw, memory_type: "relationship_milestone", temporal: {},
  provenance: raw.sources[0], provenance_sources: raw.sources,
  grounding: { verified: true, policy_version: XIAOC_MEMORY_GROUNDING_POLICY_VERSION } })
const nativeContext = (raw = saved(), messages = [announcement, image, reveal]) => ({
  trustedUserId: "fictional-owner", requestedUserId: "fictional-owner",
  currentMessageId: reveal.id, currentConversationId: "fictional-chat",
  judgeResult: grounded(raw), sourceMessages: messages,
})

function fixtureClient(messages) {
  const events = new Map()
  const memories = new Map()
  const writes = []
  return { events, memories, writes,
    from(table) {
      let rows = table === "messages" ? [...messages] : [...events.values()]
      const query = {
        select() { return query }, eq(key, value) { rows = rows.filter(row => String(row[key]) === String(value)); return query },
        gte(key, value) { rows = rows.filter(row => row[key] >= value); return query },
        lte(key, value) { rows = rows.filter(row => row[key] <= value); return query },
        order(key, { ascending = true } = {}) { rows.sort((a,b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1)); return query }, limit(n) { rows = rows.slice(0,n); return query },
        maybeSingle: async () => ({ data: rows[0] || null }),
        then(resolve, reject) { return Promise.resolve({ data: rows }).then(resolve, reject) },
      }
      return query
    },
    async rpc(name, input) {
      writes.push({ name, input })
      if (name === "xiaoc_memory_event_claim_expired") {
        const due = [...events.values()].filter(event => event.status === "deferred")
        for (const event of due) event.status = "evaluating"
        return { data: due }
      }
      const key = input.p_event_start_message_id
      if (name === "xiaoc_memory_event_decide") {
        const previous = events.get(key)
        if (input.p_expected_updated_at && previous?.updated_at !== input.p_expected_updated_at) return { data: null }
        const old = messages.find(m => m.id === previous?.last_message_id)
        const current = messages.find(m => m.id === input.p_current_message_id)
        if (old && current && old.created_at > current.created_at) return { data: null }
        if (input.p_action === "reject" && messages.some(m => m.role === "user" && m.created_at > current?.created_at)) return { data: null }
        if (previous?.status === "captured" || previous?.status === "closed") return { data: null }
        events.set(key, { ...(previous || {}), event_start_message_id: key, conversation_id: input.p_conversation_id,
          user_id: input.p_user_id, last_message_id: input.p_current_message_id,
          created_at: at, expires_at: previous?.expires_at || "2026-01-01T10:20:00Z",
          status: input.p_action === "defer" ? "deferred" : "closed" })
        return { data: null }
      }
      if (name === "xiaoc_memory_capture_event_verified") {
        if (!memories.has(key)) memories.set(key, `fictional-memory-${memories.size + 1}`)
        events.set(key, { event_start_message_id: key, user_id: input.p_user_id,
          conversation_id: input.p_conversation_id, status: "captured", created_at: at, expires_at: at,
          memory_id: memories.get(key), last_message_id: input.p_current_message_id })
        return { data: memories.get(key) }
      }
      throw new Error(`unexpected RPC ${name}`)
    },
  }
}

test("gift announcement, image, reveal save one complete memory with all user evidence", async () => {
  const client = fixtureClient([announcement, image, reveal])
  const base = { client, env, userId: "fictional-owner", conversationId: "fictional-chat", now: new Date(at) }
  await runMemoryEventCapture({ ...base, currentMessageId: announcement.id,
    judge: async () => ({ save: false, action: "defer", event_start_message_id: announcement.id }) })
  assert.equal(client.memories.size, 0)
  await runMemoryEventCapture({ ...base, currentMessageId: image.id,
    judge: async () => ({ save: false, action: "defer", event_start_message_id: announcement.id }) })
  assert.equal(client.memories.size, 0)
  const result = await runMemoryEventCapture({ ...base, currentMessageId: reveal.id, judge: async () => grounded(saved()) })
  assert.equal(result.outcome, "success")
  assert.equal(client.memories.size, 1)
  const write = client.writes.find(item => item.name === "xiaoc_memory_capture_event_verified")
  assert.deepEqual(write.input.p_sources, [source(announcement), source(reveal)])
})

test("multi-source Judge jointly grounds a canonical and preserves perspective", async () => {
  let verified = null
  const result = await judgeMemory(reveal.content, { allowedUserSources: [announcement, reveal],
    eventContext: { events: [], messages: [announcement, reveal], expired: false },
    fetchImpl: async () => response(saved()), groundingVerifier: async candidate => {
      verified = candidate.provenance_sources; return { supported: true, reason_code: "SUPPORTED" }
    } })
  assert.equal(result.save, true)
  assert.equal(result.content, saved().content)
  assert.equal(verified.length, 2)
})

test("unfinished event can defer; expiry cannot defer again", async () => {
  const options = { allowedUserSources: [announcement],
    fetchImpl: async () => response({ action: "defer", save: false, event_start_message_id: announcement.id }) }
  assert.equal((await judgeMemory(announcement.content, { ...options, eventContext: { events: [], expired: false } })).action, "defer")
  assert.equal((await judgeMemory(announcement.content, { ...options, eventContext: { events: [], expired: true } })).reason, "event_contract_invalid")
  const client = fixtureClient([announcement])
  client.events.set(announcement.id, { user_id: "fictional-owner", conversation_id: "fictional-chat",
    event_start_message_id: announcement.id, last_message_id: announcement.id, status: "deferred", created_at: at, expires_at: at })
  await reevaluateExpiredMemoryEvents({ client, env, userId: "fictional-owner", run: async () => { throw new Error("unsupported expired event") } })
  assert.equal(client.events.get(announcement.id).status, "closed")
})

test("window is bounded, chronological, raw, and isolates owner and conversation", () => {
  const rows = selectMemoryEventWindow([reveal, image, announcement,
    message(3, "foreign", "user", { user_id: "other" }),
    message(4, "foreign", "user", { conversation_id: "other" })],
  { userId: "fictional-owner", conversationId: "fictional-chat", at: reveal.created_at })
  assert.deepEqual(rows.map(row => row.id), [announcement.id, image.id, reveal.id])
  assert.equal(rows[1].content, "")
  assert.equal(rows[1].image_context.evidence_allowed, false)
  assert.equal(MEMORY_EVENT_WINDOW.messages, 24)
})

test("window loss closes deferred event without unsupported memory", async () => {
  const client = fixtureClient([reveal])
  client.events.set(announcement.id, { user_id: "fictional-owner", conversation_id: "fictional-chat",
    event_start_message_id: announcement.id, last_message_id: announcement.id, status: "deferred", created_at: at, expires_at: at })
  await runMemoryEventCapture({ client, env, userId: "fictional-owner", conversationId: "fictional-chat", currentMessageId: reveal.id,
    judge: async () => ({ save: false, content: "" }) })
  assert.equal(client.events.get(announcement.id).status, "closed")
  assert.equal(client.memories.size, 0)
})

test("two independent event roots remain separate and repeat/concurrent execution is idempotent", async () => {
  const independent = message(4, "我完成了长期志愿服务计划")
  const client = fixtureClient([announcement, reveal, independent])
  const context = nativeContext()
  await Promise.all([1, 2].map(() => runXiaoCMemoryNativeCapture({ ...context, client, env })))
  assert.equal(client.memories.size, 1)
  const other = saved()
  other.event_start_message_id = independent.id
  other.sources = [source(independent)]
  other.content = "她完成了长期志愿服务计划。"
  await runXiaoCMemoryNativeCapture({ ...nativeContext(other, [announcement, reveal, independent]), currentMessageId: independent.id, client, env })
  assert.equal(client.memories.size, 2)
})

test("every native source rejects owner/conversation/role/identity and non-exact evidence", () => {
  for (const overrides of [{ user_id: "other" }, { conversation_id: "other" }, { role: "assistant" }, { id: ids[4] }, { content: "different" }]) {
    const result = validateXiaoCMemoryNativeCaptureInput(nativeContext(saved(), [announcement, { ...reveal, ...overrides }]))
    assert.equal(result.eligible, false)
  }
})

test("generated image description cannot be user-authored evidence", async () => {
  const raw = saved()
  raw.sources.push({ ...source(image), evidence_text: "example.invalid" })
  const result = await judgeMemory(reveal.content, { allowedUserSources: [announcement, image, reveal],
    eventContext: { events: [], expired: false }, fetchImpl: async () => response(raw) })
  assert.equal(result.save, false)
  assert.equal(result.reason, "source_message_not_allowed")
})

test("unsupported joint facts and database-style subject fail closed", async () => {
  const options = { allowedUserSources: [announcement, reveal], eventContext: { events: [], expired: false },
    fetchImpl: async () => response(saved()), groundingVerifier: async () => ({ supported: false, reason_code: "UNSUPPORTED_FACT" }) }
  assert.equal((await judgeMemory(reveal.content, options)).reason, "unsupported_canonical")
  assert.equal((await judgeMemory(reveal.content, { ...options, fetchImpl: async () => response({ ...saved(), content: "用户购买了域名。" }) })).reason, "canonical_perspective_invalid")
})

test("actual grounding request carries the complete evidence union and no image facts", async () => {
  const requests = []
  const result = await judgeMemory(reveal.content, { allowedUserSources: [announcement, image, reveal],
    eventContext: { events: [], messages: [announcement, image, reveal], expired: false },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body)
      requests.push(body)
      return response(requests.length === 1 ? saved() : { supported: true, reason_code: "SUPPORTED" })
    } })
  assert.equal(result.save, true)
  assert.equal(requests.length, 2)
  const grounding = requests[1].messages[0].content
  assert.ok(grounding.includes(announcement.content))
  assert.ok(grounding.includes(reveal.content))
  assert.ok(grounding.includes(announcement.id))
  assert.ok(grounding.includes(reveal.id))
  assert.ok(!grounding.includes("example.invalid"))
  assert.ok(grounding.includes("assistant 和模型图片描述不能提供新事实"))
})

test("captured and closed event identities cannot be selected again", async () => {
  for (const status of ["captured", "closed"]) {
    const result = await judgeMemory(reveal.content, { allowedUserSources: [announcement, reveal],
      eventContext: { events: [{ event_start_message_id: announcement.id, status }], expired: false },
      fetchImpl: async () => response(saved()) })
    assert.equal(result.save, false)
    assert.equal(result.reason, "event_contract_invalid")
  }
})

test("multiple event expiry workers claim one bounded reevaluation", async () => {
  const client = fixtureClient([announcement])
  client.events.set(announcement.id, { user_id: "fictional-owner", conversation_id: "fictional-chat",
    event_start_message_id: announcement.id, last_message_id: announcement.id, status: "deferred", created_at: at, expires_at: at })
  let calls = 0
  const run = async () => { calls++ }
  await Promise.all([1, 2].map(() => reevaluateExpiredMemoryEvents({ client, env, userId: "fictional-owner", run })))
  assert.equal(calls, 1)
})

test("migration retains old RPC, atomic writer, exact provenance, permission and race guards", () => {
  const sql = readFileSync("supabase_xiaoc_memory_event_capture.sql", "utf8")
  assert.match(sql, /pg_advisory_xact_lock/)
  assert.match(sql, /for update skip locked/)
  assert.match(sql, /public\.xiaoc_memory_capture_verified\(/)
  assert.match(sql, /insert into public\.memory_provenance/)
  assert.match(sql, /position\(v_evidence->>'evidence_text'/)
  assert.match(sql, /revoke all on function/)
  assert.match(sql, /grant execute[\s\S]*to service_role/)
  assert.doesNotMatch(sql, /delete from public\.memory_items|update public\.memory_items|create or replace function public\.xiaoc_memory_capture_verified/)
})

test("grounding sees full hypothetical and negated source despite shortened evidence", async () => {
  for (const text of ["如果我辞职，我会担心没有存款。", "我没有辞职，我只是担心没有存款。"]) {
    const m = message(0, text)
    let calls = 0
    const result = await judgeMemory(text, { allowedUserSources: [m],
      fetchImpl: async (_url, request) => {
        const prompt = JSON.parse(request.body).messages[0].content
        if (++calls === 1) return response({ save: true, category: "personal_fact", content: "她已经辞职，没有存款。",
          ...source(m), evidence_text: "担心没有存款" })
        assert.ok(prompt.includes(text))
        assert.ok(prompt.includes("hypothetical/planned/feared"))
        return response({ supported: false, reason_code: "UNSUPPORTED_FACT" })
      } })
    assert.equal(result.save, false)
    assert.equal(calls, 2)
  }
})

test("role-labelled context resolves references without admitting assistant evidence or temporary value", async () => {
  const q = message(0, "Mochi在哪里？", "assistant")
  const answer = message(1, "在乡下和家人在一起。")
  let calls = 0
  const result = await judgeMemory(answer.content, { allowedUserSources: [answer],
    eventContext: { messages: [q, answer], events: [], expired: false },
    fetchImpl: async (_url, request) => {
      if (++calls === 1) return response({ action: "save", save: true, event_start_message_id: answer.id,
        category: "personal_fact", content: "Mochi目前在乡下。", sources: [source(answer)] })
      const prompt = JSON.parse(request.body).messages[0].content
      assert.ok(prompt.includes('"role":"assistant"'))
      assert.ok(prompt.includes(q.content))
      assert.ok(prompt.includes("一次性地点/临时状态"))
      return response({ supported: false, reason_code: "OVERGENERALIZED" })
    } })
  assert.equal(result.save, false)
})

test("expiry reads latest persisted reveal instead of its old cursor", async () => {
  const client = fixtureClient([announcement, reveal])
  const event = { user_id: "fictional-owner", conversation_id: "fictional-chat", event_start_message_id: announcement.id,
    last_message_id: announcement.id, status: "evaluating", created_at: at, expires_at: at, updated_at: at }
  client.events.set(announcement.id, event)
  await runMemoryEventCapture({ client, env, userId: "fictional-owner", conversationId: "fictional-chat",
    currentMessageId: announcement.id, expiredEvent: event, now: new Date("2026-01-01T10:30:00Z"),
    judge: async (text, options) => { assert.equal(text, reveal.content)
      assert.ok(options.eventContext.messages.some(m => m.id === reveal.id))
      return grounded(saved()) } })
  assert.equal(client.events.get(announcement.id).status, "captured")
})

test("stale expiry decision cannot close a newer event and deadline never extends", async () => {
  const client = fixtureClient([announcement, reveal])
  client.events.set(announcement.id, { status: "deferred", last_message_id: reveal.id, updated_at: reveal.created_at, expires_at: at })
  await client.rpc("xiaoc_memory_event_decide", { p_event_start_message_id: announcement.id,
    p_current_message_id: announcement.id, p_action: "reject", p_expected_updated_at: at })
  assert.equal(client.events.get(announcement.id).status, "deferred")
  await client.rpc("xiaoc_memory_event_decide", { p_event_start_message_id: announcement.id,
    p_current_message_id: reveal.id, p_action: "defer" })
  assert.equal(client.events.get(announcement.id).expires_at, at)
  const sql = readFileSync("supabase_xiaoc_memory_event_capture.sql", "utf8")
  assert.match(sql, /v_event.updated_at is distinct from p_expected_updated_at/)
  assert.match(sql, /v_progress.created_at, v_progress.id/)
  assert.match(sql, /stale event capture/)
})

test("expiry reject racing a successful reveal cannot close the captured event", async () => {
  const client = fixtureClient([announcement, reveal])
  const event = { user_id: "fictional-owner", conversation_id: "fictional-chat", event_start_message_id: announcement.id,
    last_message_id: announcement.id, status: "evaluating", created_at: at, expires_at: at, updated_at: at }
  client.events.set(announcement.id, { ...event })
  const base = { client, env, userId: "fictional-owner", conversationId: "fictional-chat", now: new Date("2026-01-01T10:30:00Z") }
  await runMemoryEventCapture({ ...base, expiredEvent: event, currentMessageId: announcement.id,
    judge: async () => {
      await runMemoryEventCapture({ ...base, currentMessageId: reveal.id, judge: async () => grounded(saved()) })
      return { save: false, action: "reject", event_start_message_id: announcement.id }
    } })
  assert.equal(client.events.get(announcement.id).status, "captured")
  assert.equal(client.memories.size, 1)
})

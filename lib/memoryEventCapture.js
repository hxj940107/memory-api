import { judgeMemory } from "./memoryJudge.js"
import { isXiaoCMemoryNativeCaptureEnabled, runXiaoCMemoryNativeCapture } from "./xiaocMemoryNativeCapture.js"

export const MEMORY_EVENT_WINDOW = Object.freeze({ messages: 24, chars: 12000, ageMs: 2 * 60 * 60 * 1000, deferMs: 20 * 60 * 1000, maxUserTurns: 8, maxDeferred: 4 })

export function selectMemoryEventWindow(messages, { userId, conversationId, at }) {
  const end = Date.parse(at)
  const seen = new Set()
  const sorted = messages.filter(message => message.user_id === userId
    && message.conversation_id === conversationId && ["user", "assistant"].includes(message.role)
    && Number.isFinite(Date.parse(message.created_at)) && Date.parse(message.created_at) <= end
    && Date.parse(message.created_at) >= end - MEMORY_EVENT_WINDOW.ageMs)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || String(a.id).localeCompare(String(b.id)))
  let chars = 0
  const selected = []
  for (const message of sorted.slice(-MEMORY_EVENT_WINDOW.messages).reverse()) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    const content = String(message.content || "")
    if (content.length + chars > MEMORY_EVENT_WINDOW.chars) break
    chars += content.length
    selected.push({ id: String(message.id), user_id: userId, conversation_id: conversationId,
      role: message.role, content, created_at: message.created_at,
      image_context: message.metadata?.imageDescription
        ? { origin: "model_generated_description", text: String(message.metadata.imageDescription).slice(0, 600), evidence_allowed: false }
        : null })
  }
  return selected.reverse()
}

export async function runMemoryEventCapture({ client, userId, conversationId, currentMessageId,
  env = process.env, now = new Date(), embeddingProvider = null,
  judge = judgeMemory, capture = runXiaoCMemoryNativeCapture, expiredEvent = null }) {
  if (!isXiaoCMemoryNativeCaptureEnabled(env)) return { outcome: "skipped", reason: "FLAG_OFF" }
  if (expiredEvent) {
    const { data: latest, error: latestError } = await client.from("messages")
      .select("id,user_id,conversation_id,role,content,created_at,metadata")
      .eq("user_id", userId).eq("conversation_id", conversationId).eq("role", "user")
      .lte("created_at", new Date(now).toISOString())
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle()
    if (latestError) throw latestError
    if (!latest) throw new Error("EVENT_CURRENT_SOURCE_INVALID")
    currentMessageId = latest.id
  }
  const { data: current, error: currentError } = await client.from("messages")
    .select("id,user_id,conversation_id,role,content,created_at,metadata")
    .eq("user_id", userId).eq("conversation_id", conversationId).eq("id", currentMessageId).maybeSingle()
  if (currentError) throw currentError
  if (!current || current.role !== "user") throw new Error("EVENT_CURRENT_SOURCE_INVALID")
  const at = current.created_at
  const { data: rows, error } = await client.from("messages")
    .select("id,user_id,conversation_id,role,content,created_at,metadata")
    .eq("user_id", userId).eq("conversation_id", conversationId)
    .gte("created_at", new Date(Date.parse(at) - MEMORY_EVENT_WINDOW.ageMs).toISOString())
    .lte("created_at", at).order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(MEMORY_EVENT_WINDOW.messages)
  if (error) throw error
  const window = selectMemoryEventWindow(rows || [], { userId, conversationId, at })
  if (!window.some(message => message.id === String(currentMessageId))) throw new Error("EVENT_CURRENT_OUTSIDE_WINDOW")
  const { data: events, error: eventError } = await client.from("memory_capture_events")
    .select("event_start_message_id,status,expires_at,created_at,last_message_id,attempts,memory_id")
    .eq("user_id", userId).eq("conversation_id", conversationId)
    .gte("created_at", new Date(Date.parse(at) - MEMORY_EVENT_WINDOW.ageMs).toISOString())
    .order("created_at", { ascending: false }).limit(24)
  if (eventError) throw eventError
  const userSources = window.filter(message => message.role === "user")
  const closedRoots = []
  for (const event of events || []) {
    if (!["deferred", "evaluating"].includes(event.status)) continue
    const rootIndex = window.findIndex(message => message.id === event.event_start_message_id)
    const ended = rootIndex < 0 || window.slice(rootIndex).filter(message => message.role === "user").length > MEMORY_EVENT_WINDOW.maxUserTurns
    if (ended) {
      const result = await client.rpc("xiaoc_memory_event_decide", { p_user_id: userId,
        p_conversation_id: conversationId, p_event_start_message_id: event.event_start_message_id,
        p_current_message_id: currentMessageId, p_action: "reject",
        ...(expiredEvent ? { p_expected_updated_at: expiredEvent.updated_at } : {}) })
      if (result.error) throw result.error
      event.status = "closed"
      closedRoots.push(event.event_start_message_id)
    }
  }
  const expired = Boolean(expiredEvent)
  const decision = await judge(current.content || "", { allowedUserSources: userSources,
    assistantContext: window.filter(message => message.role === "assistant").map(message => message.content).join("\n"),
    eventContext: { messages: window, events: events || [], expired, reevaluate_event_id: expiredEvent?.event_start_message_id || null },
    referenceTime: at })
  if (expiredEvent && decision.event_start_message_id !== expiredEvent.event_start_message_id) {
    throw new Error("EVENT_EXPIRY_ROOT_MISMATCH")
  }
  if (decision.save) {
    return capture({ client, env, embeddingProvider, trustedUserId: userId, requestedUserId: userId,
      currentConversationId: conversationId, currentMessageId, currentMessage: current.content,
      sourceMessages: window, judgeResult: decision })
  }
  if (["defer", "reject"].includes(decision.action)) {
    const event = (events || []).find(item => item.event_start_message_id === decision.event_start_message_id)
    const timeout = event && Date.parse(event.expires_at) <= new Date(now).getTime()
    const action = expired || timeout || closedRoots.includes(decision.event_start_message_id) ? "reject" : decision.action
    const result = await client.rpc("xiaoc_memory_event_decide", { p_user_id: userId,
      p_conversation_id: conversationId, p_event_start_message_id: decision.event_start_message_id,
      p_current_message_id: currentMessageId, p_action: action,
      ...(expiredEvent ? { p_expected_updated_at: expiredEvent.updated_at } : {}) })
    if (result.error) throw result.error
    return { outcome: action === "defer" ? "deferred" : "closed", event_start_message_id: decision.event_start_message_id }
  }
  if (expiredEvent) {
    const result = await client.rpc("xiaoc_memory_event_decide", { p_user_id: userId,
      p_conversation_id: conversationId, p_event_start_message_id: expiredEvent.event_start_message_id,
      p_current_message_id: currentMessageId, p_action: "reject",
      p_expected_updated_at: expiredEvent.updated_at })
    if (result.error) throw result.error
  }
  return { outcome: "skipped", reason: decision.reason || "JUDGE_SAVE_FALSE" }
}

export async function reevaluateExpiredMemoryEvents({ client, userId, env = process.env,
  embeddingProvider = null, run = runMemoryEventCapture }) {
  if (!isXiaoCMemoryNativeCaptureEnabled(env)) return { checked: 0 }
  const { data, error } = await client.rpc("xiaoc_memory_event_claim_expired", { p_user_id: userId })
  if (error) throw error
  let checked = 0
  for (const event of data || []) {
    try {
      await run({ client, userId, env, embeddingProvider, conversationId: event.conversation_id,
        currentMessageId: event.last_message_id, expiredEvent: event })
    } catch {
      // An expired event gets one bounded evaluation; unsafe output/failure closes it.
      const result = await client.rpc("xiaoc_memory_event_decide", { p_user_id: userId,
        p_conversation_id: event.conversation_id, p_event_start_message_id: event.event_start_message_id,
        p_current_message_id: event.last_message_id, p_action: "reject",
        p_expected_updated_at: event.updated_at })
      if (result.error) throw result.error
    }
    checked++
  }
  return { checked }
}

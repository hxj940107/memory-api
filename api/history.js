import { createClient } from "@supabase/supabase-js"
import { requirePrivateAppRequest } from "../lib/privateAppAuth.js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SEARCH_LIMIT_DEFAULT = 30
const SEARCH_LIMIT_MAX = 60
const CONTEXT_SIDE_LIMIT = 8

function isValidMessageId(value) {
  return /^[a-zA-Z0-9_-]+$/.test(String(value || ""))
}

function escapeIlikePattern(value) {
  return String(value || "").replace(/[\\%_]/g, "\\$&")
}

function searchSnippet(content, searchQuery, radius = 72) {
  const text = String(content || "").replace(/\s+/g, " ").trim()
  const needle = String(searchQuery || "").toLocaleLowerCase()
  const index = text.toLocaleLowerCase().indexOf(needle)
  if (index < 0 || text.length <= radius * 2) return text.slice(0, radius * 2)

  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + needle.length + radius)
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
}

async function searchConversationMessages({
  user_id,
  conversation_id,
  search_query,
  limit,
  before_created_at,
  before_id,
}) {
  const text = String(search_query || "").trim().slice(0, 120)
  if (!text) return []

  let query = supabase
    .from("messages")
    .select("id,role,content,created_at")
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .in("role", ["user", "assistant"])
    .ilike("content", `%${escapeIlikePattern(text)}%`)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })

  if (before_created_at) {
    const cursorTime = new Date(String(before_created_at)).toISOString()
    query = before_id
      ? query.or(
          `created_at.lt.${cursorTime},and(created_at.eq.${cursorTime},id.lt.${before_id})`
        )
      : query.lt("created_at", cursorTime)
  }

  const safeLimit = Math.max(
    1,
    Math.min(SEARCH_LIMIT_MAX, Number(limit || SEARCH_LIMIT_DEFAULT))
  )
  const { data, error } = await query.limit(safeLimit)
  if (error) throw error

  return (data || []).map(item => ({
    id: item.id,
    role: item.role,
    snippet: searchSnippet(item.content, text),
    created_at: item.created_at,
  }))
}

async function getMessageContext({ user_id, conversation_id, target_id }) {
  if (!isValidMessageId(target_id)) {
    const error = new Error("invalid target_id")
    error.status = 400
    throw error
  }

  const { data: target, error: targetError } = await supabase
    .from("messages")
    .select("id,role,content,metadata,created_at")
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .eq("id", target_id)
    .in("role", ["user", "assistant"])
    .maybeSingle()

  if (targetError) throw targetError
  if (!target) {
    const error = new Error("message not found")
    error.status = 404
    throw error
  }

  const cursorTime = new Date(target.created_at).toISOString()
  const [beforeResult, afterResult] = await Promise.all([
    supabase
      .from("messages")
      .select("id,role,content,metadata,created_at")
      .eq("user_id", user_id)
      .eq("conversation_id", conversation_id)
      .in("role", ["user", "assistant"])
      .or(
        `created_at.lt.${cursorTime},and(created_at.eq.${cursorTime},id.lt.${target.id})`
      )
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(CONTEXT_SIDE_LIMIT),
    supabase
      .from("messages")
      .select("id,role,content,metadata,created_at")
      .eq("user_id", user_id)
      .eq("conversation_id", conversation_id)
      .in("role", ["user", "assistant"])
      .or(
        `created_at.gt.${cursorTime},and(created_at.eq.${cursorTime},id.gt.${target.id})`
      )
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(CONTEXT_SIDE_LIMIT),
  ])

  if (beforeResult.error) throw beforeResult.error
  if (afterResult.error) throw afterResult.error

  return [
    ...(beforeResult.data || []).reverse(),
    target,
    ...(afterResult.data || []),
  ].map(item => ({
    id: item.id,
    role: item.role,
    content: item.content,
    metadata: item.metadata || {},
    created_at: item.created_at,
  }))
}

export default async function handler(req, res) {
  if (!requirePrivateAppRequest(req, res)) return

  try {

    const user_id =
      req.method === "GET"
        ? req.query.user_id
        : req.body.user_id

    const conversation_id =
      req.method === "GET"
        ? req.query.conversation_id
        : req.body.conversation_id

    const limit =
      req.method === "GET"
        ? Number(req.query.limit || 50)
        : Number(req.body.limit || 50)

    const offset =
      req.method === "GET"
        ? Number(req.query.offset || 0)
        : Number(req.body.offset || 0)

    const before_created_at =
      req.method === "GET"
        ? req.query.before_created_at
        : req.body.before_created_at

    const before_id =
      req.method === "GET"
        ? req.query.before_id
        : req.body.before_id

    const action = String(
      req.method === "GET" ? req.query.action || "list" : req.body.action || "list"
    )

    const search_query =
      req.method === "GET" ? req.query.search_query : req.body.search_query

    const target_id =
      req.method === "GET" ? req.query.target_id : req.body.target_id

    if (!user_id || !conversation_id) {
      return res.status(400).json({
        error: "user_id and conversation_id are required"
      })
    }

    if (
      before_created_at &&
      Number.isNaN(new Date(String(before_created_at)).getTime())
    ) {
      return res.status(400).json({ error: "invalid before_created_at" })
    }

    if (before_id && !isValidMessageId(before_id)) {
      return res.status(400).json({ error: "invalid before_id" })
    }

    if (action === "search") {
      const data = await searchConversationMessages({
        user_id,
        conversation_id,
        search_query,
        limit,
        before_created_at,
        before_id,
      })
      return res.status(200).json(data)
    }

    if (action === "context") {
      const data = await getMessageContext({
        user_id,
        conversation_id,
        target_id,
      })
      return res.status(200).json(data)
    }

    if (action !== "list") {
      return res.status(400).json({ error: "unsupported history action" })
    }

    let query = supabase
      .from("messages")
      .select("id, role, content, metadata, created_at")
      .eq("user_id", user_id)
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })

    if (before_created_at) {
      const cursorTime = new Date(String(before_created_at)).toISOString()
      query = before_id
        ? query.or(
            `created_at.lt.${cursorTime},and(created_at.eq.${cursorTime},id.lt.${before_id})`
          )
        : query.lt("created_at", cursorTime)
    }

    const safeLimit = Math.max(1, Math.min(150, limit))
    const safeOffset = before_created_at ? 0 : Math.max(0, offset)
    const { data, error } = await query.range(
      safeOffset,
      safeOffset + safeLimit - 1
    )

    if (error) {
      return res.status(500).json({
        error: error.message
      })
    }

    return res.status(200).json(
      (data || [])
        .reverse()
        .map(item => ({
          id: item.id,
          role: item.role,
          content: item.content,
          metadata: item.metadata || {},
          created_at: item.created_at
        }))
    )

  } catch (err) {

    console.error(err)

    return res.status(Number(err.status) || 500).json({
      error: err.message
    })

  }

}

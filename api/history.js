import { createClient } from "@supabase/supabase-js"
import { requirePrivateAppRequest } from "../lib/privateAppAuth.js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

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

    if (before_id && !/^[a-zA-Z0-9_-]+$/.test(String(before_id))) {
      return res.status(400).json({ error: "invalid before_id" })
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

    return res.status(500).json({
      error: err.message
    })

  }

}

import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {

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
        ? Number(req.query.limit || 100)
        : Number(req.body.limit || 100)

    if (!user_id || !conversation_id) {
      return res.status(400).json({
        error: "user_id and conversation_id are required"
      })
    }

    const { data, error } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("user_id", user_id)
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true })
      .limit(limit)

    if (error) {
      return res.status(500).json({
        error: error.message
      })
    }

    return res.status(200).json(
      data.map(item => ({
        role: item.role,
        content: item.content
      }))
    )

  } catch (err) {

    console.error(err)

    return res.status(500).json({
      error: err.message
    })

  }

}

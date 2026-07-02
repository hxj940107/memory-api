import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {

  try {

    const user_id = req.query.user_id || "small_c"
    const conversation_id = req.query.conversation_id || "default"

    const { data, error } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("user_id", user_id)
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true })

    if (error) {
      return res.status(500).json({
        error: error.message
      })
    }

    return res.status(200).json(data)

  } catch (err) {

    return res.status(500).json({
      error: err.message
    })

  }

}

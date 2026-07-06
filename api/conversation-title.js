import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  try {

    const { user_id, conversation_id, message } = req.body

    if (!conversation_id) {
      return res.status(400).json({ error: "no conversation_id" })
    }

    // 取前15个字做标题
    const title = (message || "").slice(0, 15)

    await supabase
      .from("messages")
      .update({ title })
      .eq("conversation_id", conversation_id)
      .eq("user_id", user_id)

    return res.json({ ok: true, title })

  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}

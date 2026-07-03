import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" })
  }

  const { user_id, limit = 12 } = req.body

  try {

    const { data } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(limit)

    if (!data) {
      return res.json({
        history: []
      })
    }

    const history = data
      .reverse()
      .map(m => ({
        role: m.role,
        content: m.content
      }))

    return res.json({
      history
    })

  } catch (err) {

    console.error(err)

    return res.status(500).json({
      error: err.message
    })
  }
}

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {

  try {

    const user_id = req.query.user_id || "small_c"

    const { data, error } = await supabase
      .from("messages")
      .select("conversation_id, created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })

    if (error) {
      return res.status(500).json({
        error: error.message
      })
    }

    const map = {}

    data.forEach(item => {

      if (!map[item.conversation_id]) {

        map[item.conversation_id] = {
          id: item.conversation_id,
          title: item.title || item.conversation_id,
          created_at: item.created_at,
          latest: false
        }

      }

    })

    const conversations = Object
      .values(map)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

    if (conversations.length > 0) {
      conversations[0].latest = true
    }

    return res.status(200).json(conversations)

  } catch (err) {

    return res.status(500).json({
      error: err.message
    })

  }

}

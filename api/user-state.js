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

    if (!user_id) {
      return res.status(400).json({
        error: "user_id required"
      })
    }

    if (req.method === "POST") {
      const { last_conversation = null } = req.body

      const { error } = await supabase
        .from("user_state")
        .upsert({
          user_id,
          last_conversation,
          updated_at: new Date().toISOString()
        })

      if (error) {
        return res.status(500).json({
          error: error.message
        })
      }

      return res.status(200).json({
        last_conversation
      })
    }

    if (req.method !== "GET") {
      return res.status(405).json({
        error: "Only GET or POST allowed"
      })
    }

    const { data, error } = await supabase
      .from("user_state")
      .select("last_conversation")
      .eq("user_id", user_id)
      .single()

    if (error || !data) {
      return res.status(200).json({
        last_conversation: null
      })
    }

    return res.status(200).json({
      last_conversation: data.last_conversation
    })

  } catch (err) {

    return res.status(500).json({
      error: err.message
    })

  }

}

import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {

  try {

    const user_id = req.query.user_id

    if (!user_id) {
      return res.status(400).json({
        error: "user_id required"
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

import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  try {
    if (req.method !== "DELETE" && req.method !== "POST") {
      return res.status(405).json({
        error: "Only DELETE or POST allowed"
      })
    }

    const user_id =
      req.method === "DELETE"
        ? req.query.user_id
        : req.body.user_id

    const message_id =
      req.method === "DELETE"
        ? req.query.message_id
        : req.body.message_id

    if (!user_id || !message_id) {
      return res.status(400).json({
        error: "user_id and message_id are required"
      })
    }

    const { error } = await supabase
      .from("messages")
      .delete()
      .eq("user_id", user_id)
      .eq("id", message_id)

    if (error) {
      return res.status(500).json({
        error: error.message
      })
    }

    return res.status(200).json({
      success: true
    })
  } catch (err) {
    console.error(err)

    return res.status(500).json({
      error: err.message
    })
  }
}

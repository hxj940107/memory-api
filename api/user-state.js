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

    if (req.method === "GET" && req.query.action === "openrouter-credits") {
      try {
        const creditsRes = await fetch("https://openrouter.ai/api/v1/credits", {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`
          }
        })

        const rawCredits = await creditsRes.json().catch(() => null)

        if (!creditsRes.ok) {
          return res.status(200).json({
            balance: null,
            total_credits: null,
            total_usage: null,
            error: rawCredits?.error?.message || "OpenRouter credits unavailable"
          })
        }

        const credits = rawCredits?.data || rawCredits || {}
        const totalCredits = Number(
          credits.total_credits ?? credits.totalCredits ?? 0
        )
        const totalUsage = Number(
          credits.total_usage ?? credits.totalUsage ?? 0
        )

        return res.status(200).json({
          balance: Math.max(totalCredits - totalUsage, 0),
          total_credits: totalCredits,
          total_usage: totalUsage
        })
      } catch (error) {
        return res.status(200).json({
          balance: null,
          total_credits: null,
          total_usage: null,
          error: error.message
        })
      }
    }

    if (req.method === "POST") {
      const { last_conversation = null } = req.body
      const payload = {
        user_id,
        last_conversation,
        updated_at: new Date().toISOString()
      }

      if (last_conversation) {
        payload.last_conversation_id = last_conversation
      }

      const { error } = await supabase
        .from("user_state")
        .upsert(payload)

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
      .select("last_conversation,last_conversation_id")
      .eq("user_id", user_id)
      .single()

    if (error || !data) {
      return res.status(200).json({
        last_conversation: null
      })
    }

    return res.status(200).json({
      last_conversation: data.last_conversation_id || data.last_conversation
    })

  } catch (err) {

    return res.status(500).json({
      error: err.message
    })

  }

}

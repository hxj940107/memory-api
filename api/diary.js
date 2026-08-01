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

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("diary_entries")
        .select("id,date,display_date,title,written_at,recorder,footnote,sections,created_at")
        .eq("user_id", user_id)
        .order("date", { ascending: false })
        .order("created_at", { ascending: false })

      if (error) {
        return res.status(500).json({
          error: error.message
        })
      }

      return res.status(200).json(
        (data || []).map((item) => ({
          id: item.id,
          date: item.date,
          displayDate: item.display_date,
          title: item.title,
          writtenAt: item.written_at,
          recorder: item.recorder,
          footnote: item.footnote,
          sections: item.sections || []
        }))
      )
    }

    if (req.method === "POST") {
      const {
        id,
        date,
        displayDate,
        title,
        writtenAt,
        recorder,
        footnote,
        sections
      } = req.body

      if (!title || !date || !Array.isArray(sections)) {
        return res.status(400).json({
          error: "title, date and sections required"
        })
      }

      const { data, error } = await supabase
        .from("diary_entries")
        .insert({
          id,
          user_id,
          date,
          display_date: displayDate,
          title,
          written_at: writtenAt,
          recorder,
          footnote,
          sections
        })
        .select()
        .single()

      if (error) {
        return res.status(500).json({
          error: error.message
        })
      }

      return res.status(200).json({
        success: true,
        id: data.id
      })
    }

    return res.status(405).json({
      error: "Only GET or POST allowed"
    })

  } catch (err) {
    return res.status(500).json({
      error: err.message
    })
  }
}

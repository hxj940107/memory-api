import { createClient } from "@supabase/supabase-js"
import { judgeMemory } from "../lib/memoryJudge.js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).end()
  }

  const { user_id, content } = req.body

  const result = await judgeMemory(content)

  if (!result.save) {
    return res.json({
      saved: false
    })
  }

  const { data: existed } = await supabase
    .from("memories")
    .select("id")
    .eq("user_id", user_id)
    .eq("content", result.content)
    .limit(1)

  if (existed?.length) {
    return res.json({
      saved: false,
      reason: "duplicate"
    })
  }

  const { error } = await supabase
    .from("memories")
    .insert({
      user_id,
      content: result.content,
      metadata: {
        role: "memory",
        source: "ai",
        importance: "high"
      }
    })

  if (error) {
    console.error(error)
    return res.status(500).json({
      saved: false,
      error: error.message
    })
  }

  return res.json({
    saved: true,
    memory: result.content
  })

}

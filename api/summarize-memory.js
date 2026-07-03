import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ----------------------------
// 更智能的 memory summarizer
// ----------------------------
function summarize(memories) {

  const important = []
  const recent = []
  const tags = new Set()

  for (const m of memories) {

    const content = m.content || ""

    const importance = m.metadata?.importance

    // 1. 重要记忆
    if (importance === "high") {
      important.push(content)
    }

    // 2. 最近记忆（最多5条）
    if (recent.length < 5) {
      recent.push(content)
    }

    // 3. 类型标签
    if (m.metadata?.type) {
      tags.add(m.metadata.type)
    }
  }

  // 去重 + 压缩
  const merged = [...new Set([...important, ...recent])]

  return {
    total: memories.length,
    important,
    recent,
    tags: [...tags],

    // ⭐ V2优化：更干净的summary（用于chat context）
    summary: merged.join(" | ")
  }
}

// ----------------------------
// API
// ----------------------------
export default async function handler(req, res) {

  try {

    const user_id = req.query.user_id || "small_c"

    const { data, error } = await supabase
      .from("memories")
      .select("content, metadata, created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })

    if (error) {
      return res.status(500).json({
        error: error.message
      })
    }

    const memories = data || []

    // ⭐ V2关键优化：防止空值污染
    if (memories.length === 0) {
      return res.status(200).json({
        total: 0,
        important: [],
        recent: [],
        tags: [],
        summary: ""
      })
    }

    const result = summarize(memories)

    return res.status(200).json(result)

  } catch (err) {

    return res.status(500).json({
      error: err.message
    })
  }
}

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Only POST allowed"
      })
    }

    const {
      user_id,
      content,
      metadata = {}
    } = req.body

    // ① 让 AI 判断是否值得记忆
    const decideRes = await fetch(
      `${process.env.BASE_URL}/api/memory-decide`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: content
        })
      }
    )

    const decision = await decideRes.json()

    // ② AI 判断不用记
    if (!decision.save) {
      return res.status(200).json({
        skipped: true,
        reason: "AI decided not to save"
      })
    }

    // ③ 存 AI 总结后的长期记忆
    const { data, error } = await supabase
      .from("memories")
      .insert([
        {
          user_id,
          content: decision.memory,
          metadata: {
            ...metadata,
            role: "memory",
            source: "ai"
          }
        }
      ])
      .select()

    if (error) {
      return res.status(500).json({
        error: error.message
      })
    }

    return res.status(200).json({
      saved: true,
      memory: decision.memory,
      data
    })

  } catch (err) {

    return res.status(500).json({
      error: err.message
    })

  }

}

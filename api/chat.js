import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// 获取压缩后的记忆
async function getSummary(user_id) {

  const res = await fetch(
    `${process.env.BASE_URL}/api/summarize-memory?user_id=${user_id}`
  )

  return await res.json()

}

// 写入记忆
async function saveMemory(user_id, content) {

  await fetch(`${process.env.BASE_URL}/api/add-memory`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      user_id,
      content,
      metadata: {
        role: "user"
      }
    })
  })

}

// OpenRouter
async function callLLM(prompt) {

  const res = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "anthropic/claude-3-haiku",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    }
  )

  const data = await res.json()

  return data.choices?.[0]?.message?.content || ""

}

export default async function handler(req, res) {

  try {

    const {
      user_id = "small_c",
      message
    } = req.body

    // 获取压缩记忆
    const memory = await getSummary(user_id)

    const prompt = `
你是一位长期陪伴用户的AI助手。

下面是用户的重要长期记忆：

${memory.summary || "暂无长期记忆"}

重要信息：

${(memory.important || []).join("\n")}

用户当前消息：

${message}

请结合长期记忆自然回答，不要刻意提起"根据记忆"。
`

    const reply = await callLLM(prompt)

    await saveMemory(user_id, message)

    return res.status(200).json({
      reply,
      memory_used: memory.total || 0
    })

  } catch (err) {

    return res.status(500).json({
      error: err.message
    })

  }

}

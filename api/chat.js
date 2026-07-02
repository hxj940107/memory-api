import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// 获取长期记忆
async function getSummary(user_id) {
  const res = await fetch(
    `${process.env.BASE_URL}/api/summarize-memory?user_id=${user_id}`
  )

  return await res.json()
}

// 保存聊天记录
async function saveMessage(user_id, role, content, conversation_id) {

  await fetch(`${process.env.BASE_URL}/api/add-message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      user_id,
      role,
      content,
      conversation_id
    })
  })

}

// 保存长期记忆
async function saveMemory(user_id, content) {

  await fetch(`${process.env.BASE_URL}/api/add-memory`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      user_id,
      content
    })
  })

}

// Claude 调用
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
        model: "anthropic/claude-sonnet-4.6",
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

  // ⭐ 关键：打印完整返回（用于排查）
  console.log("OPENROUTER RESPONSE:", JSON.stringify(data, null, 2))

  const reply = data?.choices?.[0]?.message?.content

  return reply || "（无回复：模型未返回内容）"
}

export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Only POST allowed"
      })
    }

    const {
      user_id = "small_c",
      message,
      conversation_id
    } = req.body || {}

    if (!message) {
      return res.status(400).json({
        error: "message is required"
      })
    }

    const chatId = conversation_id || "chat_" + Date.now()

    // 保存用户消息
    await saveMessage(user_id, "user", message, chatId)

    // 获取记忆
    const memory = await getSummary(user_id)

    const prompt = `
你是一位长期陪伴用户的AI助手。

用户长期记忆：

${memory.summary || "暂无长期记忆"}

用户：

${message}

请自然回答，不要说"根据记忆"。
`

    // 调用模型
    const reply = await callLLM(prompt)

    // 保存 AI 回复
    await saveMessage(user_id, "assistant", reply, chatId)

    // 写入记忆
    await saveMemory(user_id, message)

    return res.status(200).json({
      reply,
      conversation_id: chatId,
      memory_used: memory.total || 0
    })

  } catch (err) {

    console.error("CHAT ERROR:", err)

    return res.status(500).json({
      error: err.message
    })

  }
}

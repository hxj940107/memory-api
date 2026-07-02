import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// 🧠 获取记忆
async function getMemory(user_id) {
  const { data } = await supabase
    .from('memories')
    .select('content')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(5)

  return data || []
}

// 🧠 写记忆
async function saveMemory(user_id, content) {
  await fetch(`${process.env.BASE_URL}/api/add-memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id, content })
  })
}

// 🧠 OpenRouter 调用
async function callLLM(prompt) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "anthropic/claude-3-haiku",
      messages: [
        { role: "user", content: prompt }
      ]
    })
  })

  const data = await res.json()
  return data.choices?.[0]?.message?.content || ""
}

export default async function handler(req, res) {
  try {
    const { user_id = "small_c", message } = req.body

    // ① 读记忆
    const memory = await getMemory(user_id)
    const memoryText = memory.map(m => m.content).join("\n")

    // ② prompt
    const prompt = `
你是一个有长期记忆的AI。

历史记忆：
${memoryText}

用户：
${message}

请结合记忆回答。
`

    // ③ AI回答
    const reply = await callLLM(prompt)

    // ④ 写入记忆
    await saveMemory(user_id, message)

    return res.status(200).json({
      reply,
      memory_used: memory.length
    })

  } catch (err) {
    return res.status(500).json({
      error: err.message
    })
  }
}

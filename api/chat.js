import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// 🧠 获取记忆
async function getMemory(user_id) {
  const { data } = await supabase
    .from('memories')
    .select('content, metadata')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(5)

  return data || []
}

// 🧠 写入记忆
async function saveMemory(user_id, content) {
  await fetch(`${process.env.BASE_URL}/api/add-memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id,
      content,
      metadata: { type: 'chat' }
    })
  })
}

// 🧠 Claude（这里你后面接 API Key）
async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-3-sonnet-20240229",
      max_tokens: 500,
      messages: [
        { role: "user", content: prompt }
      ]
    })
  })

  const data = await res.json()
  return data.content?.[0]?.text || ""
}

export default async function handler(req, res) {
  try {
    const { user_id = "small_c", message } = req.body

    // ① 查记忆
    const memory = await getMemory(user_id)

    const memoryText = memory
      .map(m => m.content)
      .join("\n")

    // ② 构建 prompt
    const prompt = `
你是一个有长期记忆的AI。

用户历史记忆：
${memoryText}

用户当前输入：
${message}

请结合记忆回答用户。
`

    // ③ Claude 回复
    const reply = await callClaude(prompt)

    // ④ 自动存记忆
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

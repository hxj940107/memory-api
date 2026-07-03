import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// 判断是否值得长期记忆
async function judgeMemory(content) {

  const prompt = `
判断下面这句话是否值得成为长期记忆。

长期记忆包括：

- 用户长期喜欢或讨厌的东西
- 用户稳定的习惯
- 用户的重要背景
- 用户的重要经历
- 用户长期目标
- 用户持续性的担忧
- 用户的重要关系
- 会影响以后聊天方式的信息

不要保存：

- 打招呼
- 日常闲聊
- 一次性的安排
- 临时情绪
- 没有长期价值的信息

如果值得保存，请返回：

{
  "save": true,
  "memory": "一句20字以内的长期事实"
}

否则返回：

{
  "save": false
}

只返回 JSON，不要解释。

内容：

${content}
`

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

  let text = data?.choices?.[0]?.message?.content || ""

  text = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()

  try {
    return JSON.parse(text)
  } catch (e) {

    console.error("Memory Parse Error:", text)

    return {
      save: false
    }
  }
}

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
    .eq("content", result.memory)
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
      content: result.memory,
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
    memory: result.memory
  })

}

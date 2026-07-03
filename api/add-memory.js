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

- 用户的喜好
- 用户的厌恶
- 性格特点
- 长期目标
- 重要事件
- 人际关系
- 持续性的情绪
- 对小C的重要信息

不要保存：

- 日常闲聊
- 问候
- 临时情绪
- 一次性的事情
- 没有长期价值的信息

如果值得保存：

返回 JSON：

{
 "save": true,
 "memory": "整理后的长期记忆"
}

否则：

{
 "save": false
}

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
        response_format: {
          type: "json_object"
        },
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

  try {
    return JSON.parse(
      data.choices[0].message.content
    )
  } catch {
    return { save: false }
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

  // 去重
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

  await supabase
    .from("memories")
    .insert({
      user_id,
      content: result.memory
    })

  return res.json({
    saved: true,
    memory: result.memory
  })

}

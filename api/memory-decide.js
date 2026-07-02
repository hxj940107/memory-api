export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Only POST allowed"
      })
    }

    const { user_id, message } = req.body || {}

    if (!message) {
      return res.status(400).json({
        error: "message is required"
      })
    }

    const prompt = `
你是一个“长期记忆提取器”。

你的任务非常严格：

👉 只能从用户输入中提取“明确事实”
👉 不能推理
👉 不能总结性评价
👉 不能扩展
👉 不能润色
👉 不能加入任何新信息

---

【允许记录的内容】
- 用户明确说出的事实
- 用户的明确偏好
- 用户的明确行为
- 用户的明确状态

---

【禁止】
- 性格描述（例如：友善、聪明）
- 推测用户意图
- 总结用户生活
- 扩展信息
- 任何没有在原句出现的信息

---

如果不适合长期记忆，返回：

{
  "save": false
}

如果适合，必须只返回：

{
  "save": true,
  "memory": "一句非常短的事实总结"
}

---

用户输入：
${message}
`

    const response = await fetch(
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

    const data = await response.json()

    let text = data?.choices?.[0]?.message?.content

    if (!text) {
      return res.status(500).json({
        error: "No response from model",
        raw: data
      })
    }

    text = text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim()

    let result

    try {
      result = JSON.parse(text)
    } catch (e) {
      return res.status(500).json({
        error: "JSON parse failed",
        raw: text
      })
    }

    return res.status(200).json(result)

  } catch (err) {

    return res.status(500).json({
      error: err.message
    })

  }

}

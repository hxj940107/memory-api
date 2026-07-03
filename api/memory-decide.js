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
你是“小C”的长期记忆判断器。

你的工作只有一个：

判断下面这句话是否值得成为长期记忆。

长期记忆应该是：

未来几个月甚至几年以后，对聊天仍然有价值的信息。

--------------------

【应该保存】

- 用户长期喜欢或讨厌的东西
- 用户稳定的习惯
- 用户的重要背景
- 用户的重要经历
- 用户长期目标
- 用户持续性的担忧
- 用户与重要的人或宠物的关系
- 用户反复提到的重要事情
- 会影响以后聊天方式的信息

--------------------

【不要保存】

- 打招呼
- 日常闲聊
- 一次性的安排
- 临时心情
- 没有长期价值的话

例如：

今天吃火锅。
今天下雨了。
我要睡觉了。

这些都不要保存。

--------------------

如果值得保存：

返回 JSON：

{
  "save": true,
  "memory": "一句20字以内的长期事实"
}

要求：

- 使用第三人称描述用户
- 不要写"用户说"
- 不要分析
- 不要推理
- 不要扩展
- 不要加入原文没有的信息

如果不值得保存：

{
  "save": false
}

--------------------

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

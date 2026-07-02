export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Only POST allowed"
      });
    }

    const { message } = req.body;

    const prompt = `
你是一名AI长期记忆管理器。

判断下面这句话是否值得作为长期记忆。

只记长期稳定的信息，例如：
- 兴趣爱好
- 职业
- 学习目标
- 饮食习惯
- 长期计划
- 人际关系
- 长期偏好

不要记：
- 打招呼
- 临时聊天
- 一次性的事情
- 情绪
- 闲聊

如果值得记：

返回JSON：

{
  "save": true,
  "memory": "一句简洁的长期记忆"
}

如果不值得：

{
  "save": false
}

用户：

${message}
`;

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "anthropic/claude-3-haiku",
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
    );

    const data = await response.json();

    const result = JSON.parse(
      data.choices[0].message.content
    );

    return res.status(200).json(result);

  } catch (err) {

    return res.status(500).json({
      error: err.message
    });

  }
}

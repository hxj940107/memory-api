export async function judgeMemory(message) {

  const prompt = `
你是 Ombre Brain 的长期记忆判断器。

请判断下面这句话是否值得写入长期记忆。

值得保存：
- 用户身份
- 用户长期偏好
- 长期计划
- 长期目标
- 长期关系
- 长期习惯
- 对未来持续有价值的信息

不要保存：
- 打招呼
- 一次性安排
- 普通聊天
- 临时情绪
- 闲聊

只返回 JSON。

格式：

{
  "save": true,
  "content": "整理后的长期记忆"
}

或者

{
  "save": false
}

用户内容：

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
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0
      })
    }
  );

  const data = await response.json();

  const text = data.choices?.[0]?.message?.content || "";

  try {
    return JSON.parse(text);
  } catch {
    return {
      save: false
    };
  }
}

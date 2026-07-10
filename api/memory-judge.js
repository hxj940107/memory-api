export default async function judgeMemory(message) {

  const prompt = `
你是 Ombre Brain 的长期记忆判断器。

判断下面内容是否值得写入长期记忆。

值得保存：
- 用户身份
- 用户喜好
- 长期计划
- 长期目标
- 长期关系
- 重要决定
- 长期习惯
- 对未来持续有价值的信息

不要保存：
- 打招呼
- 临时安排
- 一次性聊天
- 玩笑
- 普通问答
- 短期情绪

只返回 JSON，不要解释。

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

  const res = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "anthropic/claude-3.5-haiku",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        response_format: {
          type: "json_object"
        }
      })
    }
  );

  const data = await res.json();

  return JSON.parse(
    data.choices[0].message.content
  );
}

import { AI_ENDPOINTS, AI_MODELS } from "./aiConfig.js";

function extractJson(text) {
  const clean = String(text || "")
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim()

  const jsonStart = clean.indexOf("{")
  const jsonEnd = clean.lastIndexOf("}")

  if (jsonStart < 0 || jsonEnd < jsonStart) {
    return null
  }

  return clean.slice(jsonStart, jsonEnd + 1)
}

export async function judgeMemory(message, options = {}) {
  const previousContent = options.previousContent || ""
  const assistantContext = options.assistantContext || ""

  const prompt = `
你是“小C”的长期记忆判断器。

你的工作：

判断用户当前消息是否值得保存为“小C与用户之间的私人长期记忆”。
当前消息必须被视为用户亲口输入的内容。
不要把小C/assistant 的表达、回复、情绪或自我描述保存成用户记忆。
不要把“小C写过的 diary / 树洞 / 回复内容”归因给用户。

你不是关键词过滤器。你需要根据语义判断：
- 这是关于用户本人、用户与小C的关系、用户长期偏好、重要经历、情绪模式或互动方式吗？
- 未来几周、几个月甚至更久以后，小C在陪伴用户时引用它会有帮助吗？
- 它只是 XiaoC 项目开发、UI 调试、部署、成本、bug 修复、测试过程中的临时信息吗？

如果是项目开发信息，默认不要进入私人长期记忆。
但是，不要机械依赖关键词。开发讨论中也可能出现真正值得记的私人偏好。

值得保存：
- 身份信息
- 人物关系
- 长期计划
- 梦想
- 长期目标
- 喜好
- 性格特点
- 价值观
- 长期困扰
- 重要事件
- 长期习惯
- 用户与重要的人或宠物的关系
- 用户反复提到的重要事情
- 会影响以后聊天方式的信息
- 对未来几个月甚至几年仍有价值的信息
- 用户明确表达的长期使用心理，例如因为成本而不敢继续聊天
- 用户喜欢小C怎样称呼、回应、陪伴或表达
- 用户纠正小C后形成的长期互动规则，例如希望小C真实反馈，不要为了安慰而附和

不要保存：
- 打招呼
- 寒暄
- 日常闲聊
- 一次性安排
- 临时情绪
- 一次性状态
- 临时安排
- 短期提醒
- 今天/今晚/这几天发生的小事
- 无意义内容
- 闲聊
- 单次 UI 调试、界面布局、按钮、气泡、侧边栏、字体、颜色等开发过程信息
- 单次 bug、部署、push、pull、Vercel、Railway、OpenRouter、token 查询等工程事件
- “我在测试”“你刚刚出错了”“这个功能没问题了”这类临时测试状态
- diary / 树洞 / 收藏卡片的生成内容本身，除非用户明确说那里面某个事实要作为长期记忆保存
- 小C刚刚说过、写过、建议过的内容

如果用户消息包含以下表达：
- 记一下
- 记住
- 保存一下
- 别忘了
- 以后提醒我
- 这个很重要

说明用户主动希望保存。

但是：
用户主动要求保存时，仍然需要判断是否具有长期价值。
如果用户要求保存的是开发任务、临时测试、短期事项或小C输出内容本身，不要保存到私人长期记忆。

如果只是短期事项，例如今天早点睡、明天买东西、晚饭吃什么，不要保存到长期记忆。

只返回 JSON：

{
  "save": true,
  "category": "relationship_preference",
  "content": "整理后的长期记忆"
}

要求：
- content 必须描述用户的长期事实、偏好、经历、关系或状态
- 使用第三人称描述用户
- 不要写"用户说"
- 不要分析
- 不要推理
- 不要扩展
- 不要加入原文没有的信息
- 不要使用含糊主语
- 不要把小C说过的话归因给用户
- 如果用户是在纠正“这是你说的/你写的，不是我说的/我写的”，不要把被纠正的内容保存成用户事实
- 如果当前消息主要是在指出小C主语搞混、记错、归因错误，通常不要保存为长期记忆，除非用户明确表达了长期偏好或重要事实
- 如果 save 为 true，category 只能是以下之一：
  - personal_fact
  - relationship_memory
  - relationship_preference
  - meaningful_experience
  - long_term_concern

如果不保存，category 应说明原因，只能是以下之一：
  - project_dev
  - temporary_test
  - assistant_output
  - casual_chat
  - short_term
  - not_long_term

如果 save 为 false：
content 必须为空字符串。
例如：

{
  "save": false,
  "category": "project_dev",
  "content": ""
}

当前用户消息：

${message}

上一条用户消息：

${previousContent}

上一条小C回复：

${assistantContext}
`

  const response = await fetch(
    AI_ENDPOINTS.openRouterChatCompletions,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: AI_MODELS.memoryJudge,
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
  const jsonText = extractJson(text)

  try {
    const result = JSON.parse(jsonText || "{}")

    return {
      save: Boolean(result.save),
      category: String(result.category || "").trim(),
      content: result.save ? String(result.content || "").trim() : ""
    }
  } catch {
    return {
      save: false,
      category: "",
      content: ""
    };
  }
}

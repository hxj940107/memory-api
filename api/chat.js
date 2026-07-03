import { createClient } from '@supabase/supabase-js'
import fs from "fs"
import path from "path"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// 读取人格系统
const systemPrompt = fs.readFileSync(
  path.join(process.cwd(), "prompt/system.md"),
  "utf-8"
)

// 保存聊天
async function saveMessage(user_id, role, content, conversation_id) {
  await fetch(`${process.env.BASE_URL}/api/add-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id,
      role,
      content,
      conversation_id
    })
  })
}

// 保存记忆
async function saveMemory(user_id, content) {
  await fetch(`${process.env.BASE_URL}/api/add-memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id,
      content,
      metadata: { importance: "high" }
    })
  })
}

// 🧠 相关记忆（轻量化）
async function getRelevantMemory(user_id, message) {

  const { data: memories } = await supabase
    .from("memories")
    .select("content, metadata")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })

  if (!memories) return ""

  const keywords = message.toLowerCase().split(" ")

  const relevant = memories
    .filter(m =>
      keywords.some(k =>
        m.content.toLowerCase().includes(k)
      )
    )
    .slice(0, 5)

  const fallback = memories.slice(0, 3)

  const final = (relevant.length > 0 ? relevant : fallback)

  return final.map(m => m.content).join(" | ")
}

// 调用模型
async function callLLM(messages) {

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
        messages
      })
    }
  )

  const data = await res.json()

  return data?.choices?.0?.message?.content || "（无回复）"
}

export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" })
    }

    const {
      user_id = "small_c",
      message,
      conversation_id
    } = req.body || {}

    const chatId = conversation_id || ("chat_" + Date.now())

    await saveMessage(user_id, "user", message, chatId)

    // 🧠 记忆（弱化为背景）
    const memoryText = await getRelevantMemory(user_id, message)

    const memoryBlock = memoryText
      ? `（背景信息，仅供理解，不要复述）\n${memoryText}`
      : "暂无"

    // 🧠 最终人格结构（稳定版）
    const messages = [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "system",
        content: `
【关系】
你们是长期关系

【记忆（背景）】
${memoryBlock}

【当前对话】
${message}

【要求】
自然聊天，不总结，不像AI助手
        `
      }
    ]

    const reply = await callLLM(messages)

    await saveMessage(user_id, "assistant", reply, chatId)

    await saveMemory(user_id, message)

    return res.status(200).json({
      reply,
      conversation_id: chatId
    })

  } catch (err) {

    console.error(err)

    return res.status(500).json({
      error: err.message
    })

  }
}

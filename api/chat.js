import { createClient } from '@supabase/supabase-js'
import fs from "fs"
import path from "path"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// 读取 system prompt（人格）
const systemPrompt = fs.readFileSync(
  path.join(process.cwd(), "prompt/system.md"),
  "utf-8"
)

// 获取 memory
async function getSummary(user_id) {

  const { data, error } = await supabase
    .from("memories")
    .select("content, metadata, created_at")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })

  if (error) throw new Error(error.message)

  const important = []
  const recent = []
  const tags = new Set()

  for (const m of data || []) {

    if (m.metadata?.importance === "high") {
      important.push(m.content)
    }

    if (recent.length < 5) {
      recent.push(m.content)
    }

    if (m.metadata?.type) {
      tags.add(m.metadata.type)
    }
  }

  const summary = [...new Set([...important, ...recent])]

  return {
    total: data?.length || 0,
    important,
    recent,
    tags: [...tags],
    summary: summary.join(" | ")
  }
}

// 保存 message
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

// 保存 memory
async function saveMemory(user_id, content) {

  await fetch(`${process.env.BASE_URL}/api/add-memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id,
      content,
      metadata: {
        importance: "high"
      }
    })
  })

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

  return data?.choices?.[0]?.message?.content || "（无回复）"
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

    if (!message) {
      return res.status(400).json({ error: "message is required" })
    }

    const chatId = conversation_id || ("chat_" + Date.now())

    await saveMessage(user_id, "user", message, chatId)

    const memory = await getSummary(user_id)

    const strongMemory =
      memory.important.length > 0
        ? memory.important.join(" | ")
        : memory.summary

    // 🔥 关键：人格 + 记忆 + 用户输入拆分为 system/user
    const messages = [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: `
用户长期记忆：
${strongMemory || "暂无长期记忆"}

用户输入：
${message}
        `
      }
    ]

    const reply = await callLLM(messages)

    await saveMessage(user_id, "assistant", reply, chatId)

    await saveMemory(user_id, message)

    return res.status(200).json({
      reply,
      conversation_id: chatId,
      memory_used: memory.total
    })

  } catch (err) {

    console.error(err)

    return res.status(500).json({
      error: err.message
    })

  }
}

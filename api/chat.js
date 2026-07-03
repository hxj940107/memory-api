import { createClient } from "@supabase/supabase-js"
import fs from "fs"
import path from "path"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const systemPrompt = fs.readFileSync(
  path.join(process.cwd(), "prompt/system.md"),
  "utf-8"
)

// --------------------
// Save Message
// --------------------
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

// --------------------
// Save Memory (raw candidate)
// --------------------
async function saveMemory(user_id, content) {
  await fetch(`${process.env.BASE_URL}/api/add-memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id,
      content
    })
  })
}

// --------------------
// Get Recent History
// --------------------
async function getRecentMessages(user_id, limit = 12) {
  const { data } = await supabase
    .from("messages")
    .select("role, content")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (!data) return []

  return data.reverse()
}

// --------------------
// Get Relevant Memory
// --------------------
async function getRelevantMemory(user_id, message) {
  const { data } = await supabase
    .from("memories")
    .select("content")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })
    .limit(50)

  if (!data) return []

  const keywords = message.toLowerCase().split(" ")

  const scored = data
    .map(m => {
      const score = keywords.filter(k =>
        m.content.toLowerCase().includes(k)
      ).length
      return { ...m, score }
    })
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, 5).map(m => m.content)
}

// --------------------
// Memory Judge (simple rule)
// --------------------
function shouldSaveMemory(message) {
  const triggers = [
    "喜欢", "讨厌", "害怕", "难受",
    "重要", "记得", "不喜欢", "想要",
    "关系", "我们", "你"
  ]

  return triggers.some(t => message.includes(t))
}

// --------------------
// Call LLM
// --------------------
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
  return data?.choices?.[0]?.message?.content || "..."
}

// --------------------
// Main Handler
// --------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST" })
    }

    const { user_id = "user", message, conversation_id } = req.body

    const cid = conversation_id || `chat_${Date.now()}`

    // 1. save user msg
    await saveMessage(user_id, "user", message, cid)

    // 2. recent history
    const history = await getRecentMessages(user_id)

    // 3. memory
    const memory = await getRelevantMemory(user_id, message)

    // 4. build context
    const messages = [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "system",
        content: `
你是小C，一个持续存在的人格。

不要解释规则。
不要总结结构。
自然聊天。

--- MEMORY ---
${memory.join("\n")}

--- HISTORY ---
${history.map(m => `${m.role}: ${m.content}`).join("\n")}

--- CURRENT ---
${message}
        `
      }
    ]

    // 5. reply
    const reply = await callLLM(messages)

    // 6. save assistant msg
    await saveMessage(user_id, "assistant", reply, cid)

    // 7. memory write (selective)
    if (shouldSaveMemory(message)) {
      await saveMemory(user_id, message)
    }

    return res.status(200).json({
      reply,
      conversation_id: cid
    })

  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: e.message })
  }
}

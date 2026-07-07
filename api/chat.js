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
// MEMORY CACHE (NEW)
// --------------------
const memoryCache = new Map()

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
  await fetch("https://ombre-brain-production-ab16.up.railway.app/hold-hook", {
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
async function getRecentMessages(user_id, limit = 6) {
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
// MEMORY (NEW LOGIC)
// --------------------
async function getMemorySmart(user_id, message, conversation_id) {
  const key = `${user_id}:${conversation_id}`

  // 1. cache hit → no API call
  if (memoryCache.has(key)) {
    return memoryCache.get(key)
  }

  // 2. first time → call breath-hook
  try {
    const res = await fetch(
      "https://ombre-brain-production-ab16.up.railway.app/breath-hook"
    )

    if (!res.ok) return []

    const txt = await res.text()

    const memory = txt
      ? [txt]
      : []

    // 3. save cache
    memoryCache.set(key, memory)

    return memory
  } catch (err) {
    console.error("memory failed:", err)
    return []
  }
}
// --------------------
// Memory Judge
// --------------------
function shouldSaveMemory(message) {
  const triggers = [
    "这个记一下",
    "刚刚这个记一下",
    "上一条记一下",
    "记住刚刚那个"
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

  return {
    reply: data?.choices?.[0]?.message?.content || "...",
    usage: data?.usage || {},
    raw: data
  }
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

    // 2. history
    const history = await getRecentMessages(user_id)

    // 3. memory (NEW SMART)
const memory = await getMemorySmart(user_id, message, cid)

// 4. build context

console.log("MEMORY LENGTH:", JSON.stringify(memory).length)
console.log("HISTORY LENGTH:", JSON.stringify(history).length)
console.log("SYSTEM LENGTH:", systemPrompt.length)

const messages = [
  {
    role: "system",
    content: systemPrompt
  },
  ...history,
  {
    role: "system",
    content: `长期记忆（仅在自然相关时使用）：

${memory.join("\n")}
`
  },
  {
    role: "user",
    content: message
  }
]

// ===== Prompt Inspector =====
console.log("\n===== FINAL MESSAGES =====")

messages.forEach((m, i) => {
  console.log(
    `${i}. ${m.role} | ${m.content.length} chars`
  )
})

console.log("==========================\n")

// 5. reply
const llm = await callLLM(messages)
const reply = llm.reply

console.log("\n========== Prompt Inspector ==========")
console.log(llm.usage)
console.log("======================================\n")

    // 6. save assistant
    await saveMessage(user_id, "assistant", reply, cid)

    // 6.5 update current conversation (cross-device sync)
    await supabase
      .from("user_state")
      .upsert({
        user_id,
        last_conversation: cid,
        updated_at: new Date().toISOString()
      })
    // 7. memory write
if (shouldSaveMemory(message)) {
  try {
    const lastUser = [...history]
      .reverse()
      .find(m => m.role === "user")

    if (lastUser) {
      await fetch(
        "https://ombre-brain-production-ab16.up.railway.app/hold-hook",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            content: lastUser.content
          })
        }
      )

      console.log("Saved memory:", lastUser.content)
    }
  } catch (err) {
    console.error("hold-hook failed:", err)
  }
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

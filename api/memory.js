import { createClient } from '@supabase/supabase-js'
import { AI_ENDPOINTS, APP_USER } from "../lib/aiConfig.js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function getMemoryUrl(pathname) {
  return new URL(pathname, AI_ENDPOINTS.memoryBaseUrl).toString()
}

async function fetchPinnedMemoryText(user_id) {
  const res = await fetch(
    `${getMemoryUrl(AI_ENDPOINTS.memoryBreathPath)}?user_id=${encodeURIComponent(user_id)}`
  )

  if (!res.ok) {
    return ""
  }

  return (await res.text()).trim()
}

async function fetchXiaoCMemories() {
  const readKey = process.env.XIAOC_MEMORY_READ_KEY
  const res = await fetch(getMemoryUrl("/xiaoc/memories"), {
    headers: readKey
      ? {
          "X-XiaoC-Key": readKey,
        }
      : {},
  })

  if (!res.ok) {
    throw new Error(`XiaoC memories unavailable: ${res.status}`)
  }

  const data = await res.json()
  const memories = data?.memories

  if (!Array.isArray(memories)) {
    throw new Error("XiaoC memories response is not an array")
  }

  return memories
}

async function postXiaoCMemoryAction(pathname, body) {
  const writeKey = process.env.XIAOC_MEMORY_WRITE_KEY

  if (!writeKey) {
    throw new Error("XIAOC_MEMORY_WRITE_KEY is not configured")
  }

  const res = await fetch(getMemoryUrl(pathname), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-XiaoC-Key": writeKey,
    },
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => null)

  if (!res.ok) {
    throw new Error(data?.error || `XiaoC memory action failed: ${res.status}`)
  }

  return data
}

function cleanMemoryText(value) {
  return String(value || "")
    .replace(/\[Ombre Brain\s*-\s*记忆浮现\]/g, "")
    .replace(/\[核心准则\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeMemoryBucket(bucket) {
  const createdAt = bucket.created || bucket.last_active || ""

  return {
    id: bucket.id,
    title: bucket.title || bucket.name || "未命名记忆",
    content: cleanMemoryText(bucket.content || bucket.content_preview || ""),
    tags: Array.isArray(bucket.tags) ? bucket.tags : [],
    domains: Array.isArray(bucket.domains)
      ? bucket.domains
      : Array.isArray(bucket.domain)
        ? bucket.domain
        : [],
    type: bucket.type || "dynamic",
    importance: Number(bucket.importance || 0),
    pinned: Boolean(bucket.pinned),
    score: Number(bucket.score || 0),
    createdAt: bucket.createdAt || createdAt,
    lastActiveAt: bucket.lastActiveAt || bucket.last_active || createdAt,
  }
}

function categorizeMemory(memory) {
  const text = `${memory.title} ${memory.content} ${memory.tags.join(" ")} ${memory.domains.join(" ")}`

  if (/关系|伴侣|老婆|老公|小C|小c|回应|互动|陪伴|喜欢.*说|称呼/.test(text)) {
    return "我们之间"
  }

  if (/经历|一起|今天|昨天|那次|时刻|聊天|完成|项目|bug|diary|树洞/.test(text)) {
    return "一起经历过"
  }

  if (/喜欢|偏好|习惯|常用|口味|小狗|狗|睡觉|饮食|生活|用户名|身份|生日/.test(text)) {
    return "关于你"
  }

  return "小小偏好"
}

function buildWeMemoryResponse(memories, source = "ombre") {
  const now = Date.now()
  const recentSince = now - 7 * 24 * 60 * 60 * 1000
  const recentCount = memories.filter((memory) => {
    const timestamp = new Date(memory.createdAt || memory.lastActiveAt).getTime()

    return !Number.isNaN(timestamp) && timestamp >= recentSince
  }).length
  const pinned = memories
    .filter((memory) => memory.pinned)
    .sort((a, b) => b.importance - a.importance || b.score - a.score)
  const pinnedIds = new Set(pinned.map((memory) => memory.id))
  const categories = ["关于你", "我们之间", "一起经历过", "小小偏好"].map((name) => ({
    name,
    items: memories
      .filter((memory) => !memory.pinned && categorizeMemory(memory) === name)
      .sort((a, b) => b.importance - a.importance || b.score - a.score)
      .slice(0, 6),
  }))
  const recent = [...memories]
    .filter((memory) => !(source !== "ombre" && pinnedIds.has(memory.id)))
    .sort((a, b) =>
      String(b.lastActiveAt || b.createdAt).localeCompare(
        String(a.lastActiveAt || a.createdAt)
      )
    )
    .slice(0, 8)

  return {
    source,
    total: memories.length,
    pinnedTotal: pinned.length,
    recentCount,
    recentWindowLabel: "最近 7 天",
    pinned: pinned.slice(0, 10),
    categories,
    recent,
  }
}

export default async function handler(req, res) {
  try {

    const user_id =
      req.method === "GET"
        ? req.query.user_id || APP_USER.defaultUserId
        : req.body.user_id || APP_USER.defaultUserId

    const type =
      req.method === "GET"
        ? req.query.type
        : req.body.type

    if (req.method === "POST" && type === "we") {
      const action = req.body.action
      const bucket_id = req.body.bucket_id

      if (!bucket_id) {
        return res.status(400).json({
          error: "bucket_id required",
        })
      }

      if (action === "pin") {
        const result = await postXiaoCMemoryAction("/xiaoc/memory/pin", {
          bucket_id,
          pinned: Boolean(req.body.pinned),
        })

        return res.status(200).json(result)
      }

      if (action === "delete") {
        const result = await postXiaoCMemoryAction("/xiaoc/memory/delete", {
          bucket_id,
        })

        return res.status(200).json(result)
      }

      return res.status(400).json({
        error: "unsupported we memory action",
      })
    }

    if (req.method === "GET" && type === "we") {
      try {
        const buckets = await fetchXiaoCMemories()
        const memories = buckets.map(normalizeMemoryBucket)

        return res.status(200).json(buildWeMemoryResponse(memories, "ombre-xiaoc"))
      } catch (error) {
        console.error("we memory xiaoc endpoint failed:", error)

        const [pinText, { data, error: supabaseError }] = await Promise.all([
          fetchPinnedMemoryText(user_id).catch(() => ""),
          supabase
            .from("memories")
            .select("content, metadata, created_at")
            .eq("user_id", user_id)
            .order("created_at", { ascending: false })
            .limit(40),
        ])

        if (supabaseError) {
          return res.status(500).json({
            error: supabaseError.message,
          })
        }

        const fallbackMemories = []

        if (pinText) {
          fallbackMemories.push({
            id: "ombre_pinned_breath",
            title: "我们的约定",
            content: cleanMemoryText(pinText),
            tags: ["钉选"],
            domains: ["我们"],
            type: "pinned",
            importance: 10,
            pinned: true,
            score: 10,
            createdAt: "",
            lastActiveAt: "",
          })
        }

        for (const item of data || []) {
          fallbackMemories.push({
            id: item.metadata?.id || item.created_at || item.content,
            title: item.metadata?.title || item.content?.slice(0, 28) || "记忆",
            content: item.content || "",
            tags: Array.isArray(item.metadata?.tags) ? item.metadata.tags : [],
            domains: Array.isArray(item.metadata?.domain) ? item.metadata.domain : [],
            type: item.metadata?.type || "stable",
            importance: Number(item.metadata?.importance || 5),
            pinned: Boolean(item.metadata?.pinned),
            score: Number(item.metadata?.score || 0),
            createdAt: item.created_at,
            lastActiveAt: item.created_at,
          })
        }

        return res.status(200).json(
          buildWeMemoryResponse(fallbackMemories, pinText ? "fallback-with-pin" : "fallback")
        )
      }
    }

    if (type === "diary") {
      if (req.method === "DELETE") {
        const id = req.body.id

        if (!id) {
          return res.status(400).json({
            error: "id required"
          })
        }

        const { error } = await supabase
          .from("diary_entries")
          .delete()
          .eq("user_id", user_id)
          .eq("id", id)

        if (error) {
          return res.status(500).json({
            error: error.message
          })
        }

        return res.status(200).json({
          success: true
        })
      }

      if (req.method === "GET") {
        const { data, error } = await supabase
          .from("diary_entries")
          .select("id,date,display_date,title,written_at,recorder,footnote,sections,created_at")
          .eq("user_id", user_id)
          .order("date", { ascending: false })
          .order("created_at", { ascending: false })

        if (error) {
          return res.status(500).json({
            error: error.message
          })
        }

        return res.status(200).json(
          (data || []).map((item) => ({
            id: item.id,
            date: item.date,
            displayDate: item.display_date,
            title: item.title,
            writtenAt: item.written_at,
            recorder: item.recorder,
            footnote: item.footnote,
            sections: item.sections || []
          }))
        )
      }

      if (req.method === "POST") {
        const {
          id,
          date,
          displayDate,
          title,
          writtenAt,
          recorder,
          footnote,
          sections
        } = req.body

        if (!title || !date || !Array.isArray(sections)) {
          return res.status(400).json({
            error: "title, date and sections required"
          })
        }

        const { data, error } = await supabase
          .from("diary_entries")
          .insert({
            id,
            user_id,
            date,
            display_date: displayDate,
            title,
            written_at: writtenAt,
            recorder,
            footnote,
            sections
          })
          .select()
          .single()

        if (error) {
          return res.status(500).json({
            error: error.message
          })
        }

        return res.status(200).json({
          success: true,
          id: data.id
        })
      }

      return res.status(405).json({
        error: "Only GET, POST or DELETE allowed for diary"
      })
    }

    if (type === "moments") {
      if (req.method === "DELETE") {
        const id = req.body.id

        if (!id) {
          return res.status(400).json({
            error: "id required"
          })
        }

        const { error } = await supabase
          .from("moment_entries")
          .delete()
          .eq("user_id", user_id)
          .eq("id", id)

        if (error) {
          return res.status(500).json({
            error: error.message
          })
        }

        return res.status(200).json({
          success: true
        })
      }

      if (req.method === "GET") {
        const { data, error } = await supabase
          .from("moment_entries")
          .select("id,author,text,image_key,likes,created_at")
          .eq("user_id", user_id)
          .order("created_at", { ascending: false })
          .limit(60)

        if (error) {
          return res.status(500).json({
            error: error.message
          })
        }

        return res.status(200).json(
          (data || []).map((item) => ({
            id: item.id,
            author: item.author || "小C",
            text: item.text || "",
            image: item.image_key || null,
            likes: Number(item.likes || 0),
            createdAt: item.created_at
          }))
        )
      }

      if (req.method === "POST") {
        const { text, image, likes = 0 } = req.body

        if (!String(text || "").trim()) {
          return res.status(400).json({
            error: "text required"
          })
        }

        const { data, error } = await supabase
          .from("moment_entries")
          .insert({
            user_id,
            author: "小C",
            text: String(text).trim(),
            image_key: image || null,
            likes
          })
          .select()
          .single()

        if (error) {
          return res.status(500).json({
            error: error.message
          })
        }

        return res.status(200).json({
          success: true,
          id: data.id
        })
      }

      return res.status(405).json({
        error: "Only GET, POST or DELETE allowed for moments"
      })
    }

    const { data, error } = await supabase
      .from("memories")
      .select("content, metadata, created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(20)

    if (error) {
      return res.status(500).json({
        error: error.message
      })
    }

    const memories = data || []

    // 去掉空内容
    const cleaned = memories.filter(
      m => m.content && m.content.trim() !== ""
    )

    // 去重（保留最新）
    const unique = []
    const seen = new Set()

    for (const m of cleaned) {
      if (!seen.has(m.content)) {
        seen.add(m.content)
        unique.push(m)
      }
    }

    // chat.js 用的 summary
    const summary = unique
      .map(m => m.content)
      .join(" | ")

    return res.status(200).json({
      total: unique.length,
      summary,
      memories: unique
    })

  } catch (err) {

    return res.status(500).json({
      error: err.message
    })

  }
}

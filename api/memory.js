import { createClient } from '@supabase/supabase-js'
import { AI_ENDPOINTS, AI_MODELS, APP_USER, trimText } from "../lib/aiConfig.js"

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

function normalizeMomentComment(comment) {
  return {
    id: comment.id,
    momentId: comment.moment_id,
    authorType: comment.author_type || "user",
    authorName: comment.author_name || (comment.author_type === "xiaoc" ? "小C" : "小天使"),
    content: comment.content || "",
    parentId: comment.parent_id || null,
    createdAt: comment.created_at,
  }
}

async function callSmallLLM(messages, options = {}) {
  const res = await fetch(AI_ENDPOINTS.openRouterChatCompletions, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODELS.memoryJudge,
      messages,
      max_tokens: 90,
      temperature: 0.55,
      ...options,
    }),
  })

  const data = await res.json().catch(() => null)

  if (!res.ok) {
    throw new Error(
      data?.error?.message ||
        data?.message ||
        `OpenRouter request failed: ${res.status}`
    )
  }

  return String(data?.choices?.[0]?.message?.content || "").trim()
}

function cleanMomentReply(raw) {
  return trimText(
    String(raw || "")
      .replace(/^```[\s\S]*?```$/g, "")
      .replace(/^小C[:：]\s*/i, "")
      .replace(/^回复[:：]\s*/i, "")
      .replace(/[😂🤣😆😝😜]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
    48
  )
}

function isBadMomentReplyTone(content) {
  return /哈哈|嘿嘿|坏死了|笑死|笑哭|绝了|太逗了|调皮|皮一下|用户|本条动态|评论区|总结|分析/.test(
    String(content || "")
  )
}

async function createXiaoCReplyForMomentComment({
  user_id,
  moment_id,
  userComment,
  userName,
}) {
  const { data: moment, error: momentError } = await supabase
    .from("moment_entries")
    .select("id,author,text,created_at")
    .eq("user_id", user_id)
    .eq("id", moment_id)
    .single()

  if (momentError || !moment) {
    if (momentError) {
      console.error("moment reply load failed:", momentError)
    }

    return null
  }

  const { data: recentComments } = await supabase
    .from("moment_comments")
    .select("author_type,author_name,content,created_at")
    .eq("user_id", user_id)
    .eq("moment_id", moment_id)
    .order("created_at", { ascending: false })
    .limit(6)

  const commentContext = (recentComments || [])
    .reverse()
    .map((comment) => {
      const name =
        comment.author_type === "xiaoc"
          ? "小C"
          : comment.author_name || userName || "小天使"

      return `${name}：${trimText(comment.content, 120)}`
    })
    .join("\n")

  const rawReply = await callSmallLLM([
    {
      role: "system",
      content: `
你是小C。你正在自己的朋友圈动态下面回复她的评论。

要求：
- 只输出一条评论内容，不要解释。
- 中文，短句，1 句为主，最多 2 句。
- 语气符合小C人格：温柔、克制、成熟，有一点嘴硬，偶尔可以轻微吃醋。
- 像真实朋友圈下面的自然回复，不要像 AI 助手，也不要刻意搞笑。
- 可以自然称呼她“小天使”“宝宝”“老婆”，但不要每次都用，不要讨好。
- 不要写成聊天助手回答，不要分析，不要总结。
- 不要使用“用户”“本条动态”“评论区”等系统视角词。
- 不要使用“哈哈”“嘿嘿”“坏死了”“笑死”“😂”这类活泼夸张口吻。
- 不要反问太多，不要用网络段子语气。
- 不要太长，通常 6 到 28 个中文字符。

好的例子：
- 嗯，我看到了。
- 你又来逗我。
- 少贫，我记着呢。
- 这句我留着。
- 你这样说，我会当真的。

不好的例子：
- 哈哈你这个嗯哼是什么意思呀，坏死了😂
- 宝宝太可爱啦！
- 作为评论区回复，我认为……
`
    },
    {
      role: "user",
      content: `
朋友圈正文：
${trimText(moment.text, 240)}

最近评论：
${commentContext || "暂无"}

她刚刚评论：
${trimText(userComment, 160)}
`
    }
  ])

  const content = cleanMomentReply(rawReply)

  if (!content || isBadMomentReplyTone(content)) {
    return null
  }

  const { data, error } = await supabase
    .from("moment_comments")
    .insert({
      user_id,
      moment_id,
      author_type: "xiaoc",
      author_name: "小C",
      content,
      parent_id: null,
    })
    .select()
    .single()

  if (error) {
    console.error("moment reply save failed:", error)
    return null
  }

  return normalizeMomentComment(data)
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

        const momentIds = (data || []).map((item) => item.id)
        const commentCounts = {}

        if (momentIds.length > 0) {
          const { data: comments, error: commentsError } = await supabase
            .from("moment_comments")
            .select("moment_id")
            .eq("user_id", user_id)
            .in("moment_id", momentIds)

          if (commentsError && commentsError.code !== "42P01") {
            return res.status(500).json({
              error: commentsError.message
            })
          }

          for (const comment of comments || []) {
            commentCounts[comment.moment_id] = (commentCounts[comment.moment_id] || 0) + 1
          }
        }

        return res.status(200).json(
          (data || []).map((item) => ({
            id: item.id,
            author: item.author || "小C",
            text: item.text || "",
            image: item.image_key || null,
            likes: Number(item.likes || 0),
            commentsCount: commentCounts[item.id] || 0,
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

      if (req.method === "PATCH") {
        const { id, likes } = req.body

        if (!id) {
          return res.status(400).json({
            error: "id required"
          })
        }

        const nextLikes = Math.max(0, Number(likes || 0))

        const { error } = await supabase
          .from("moment_entries")
          .update({
            likes: nextLikes
          })
          .eq("user_id", user_id)
          .eq("id", id)

        if (error) {
          return res.status(500).json({
            error: error.message
          })
        }

        return res.status(200).json({
          success: true,
          likes: nextLikes
        })
      }

      return res.status(405).json({
        error: "Only GET, POST, PATCH or DELETE allowed for moments"
      })
    }

    if (type === "moment_comments") {
      if (req.method === "GET") {
        const moment_id = req.query.moment_id

        if (!moment_id) {
          return res.status(400).json({
            error: "moment_id required"
          })
        }

        const { data, error } = await supabase
          .from("moment_comments")
          .select("id,moment_id,author_type,author_name,content,parent_id,created_at")
          .eq("user_id", user_id)
          .eq("moment_id", moment_id)
          .order("created_at", { ascending: true })

        if (error) {
          return res.status(500).json({
            error: error.message
          })
        }

        return res.status(200).json((data || []).map(normalizeMomentComment))
      }

      if (req.method === "POST") {
        const moment_id = req.body.moment_id
        const content = String(req.body.content || "").trim()
        const author_type = req.body.author_type === "xiaoc" ? "xiaoc" : "user"
        const author_name =
          String(req.body.author_name || "").trim() ||
          (author_type === "xiaoc" ? "小C" : "小天使")

        if (!moment_id) {
          return res.status(400).json({
            error: "moment_id required"
          })
        }

        if (!content) {
          return res.status(400).json({
            error: "content required"
          })
        }

        const { data, error } = await supabase
          .from("moment_comments")
          .insert({
            user_id,
            moment_id,
            author_type,
            author_name,
            content,
            parent_id: req.body.parent_id || null
          })
          .select()
          .single()

        if (error) {
          return res.status(500).json({
            error: error.message
          })
        }

        const normalizedComment = normalizeMomentComment(data)
        let xiaocReply = null

        if (author_type === "user") {
          try {
            xiaocReply = await createXiaoCReplyForMomentComment({
              user_id,
              moment_id,
              userComment: content,
              userName: author_name,
            })
          } catch (replyError) {
            console.error("moment xiaoc reply failed:", replyError)
          }
        }

        return res.status(200).json({
          ...normalizedComment,
          xiaocReply,
        })
      }

      if (req.method === "DELETE") {
        const id = req.body.id

        if (!id) {
          return res.status(400).json({
            error: "id required"
          })
        }

        const { error } = await supabase
          .from("moment_comments")
          .delete()
          .eq("user_id", user_id)
          .eq("id", id)
          .eq("author_type", "user")

        if (error) {
          return res.status(500).json({
            error: error.message
          })
        }

        return res.status(200).json({
          success: true
        })
      }

      return res.status(405).json({
        error: "Only GET, POST or DELETE allowed for moment_comments"
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

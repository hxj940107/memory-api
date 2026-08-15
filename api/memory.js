import { createClient } from '@supabase/supabase-js'
import fs from "fs"
import path from "path"
import {
  AI_ENDPOINTS,
  AI_MODELS,
  APP_USER,
  TREEHOLE_AUTONOMOUS_POLICY,
  trimText,
} from "../lib/aiConfig.js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const systemPrompt = fs.readFileSync(
  path.join(process.cwd(), "prompt/system.md"),
  "utf-8"
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

function normalizeMomentInteraction(item) {
  return {
    id: item.id,
    type: item.type,
    momentId: item.momentId,
    text: item.text || "",
    createdAt: item.createdAt,
  }
}

const MOMENT_IMAGE_BUCKET = "moment-images"
const MOMENT_TIMEZONE = "Asia/Shanghai"

function parseMomentImage(value) {
  if (!value) return { image: null, imageAspectRatio: null }

  try {
    const parsed = JSON.parse(value)

    if (parsed?.url) {
      return {
        image: parsed.url,
        imageAspectRatio: Number(parsed.aspectRatio) || null,
      }
    }
  } catch {}

  return { image: value, imageAspectRatio: null }
}

async function uploadMomentImage(user_id, imageBase64, imageMimeType, imageAspectRatio) {
  const mimeType = String(imageMimeType || "image/jpeg")

  if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) {
    throw new Error("Unsupported moment image type")
  }

  const rawBase64 = String(imageBase64 || "").replace(/^data:image\/[^;]+;base64,/, "")
  const buffer = Buffer.from(rawBase64, "base64")

  if (!buffer.length || buffer.length > 3 * 1024 * 1024) {
    throw new Error("Moment image must be smaller than 3MB")
  }

  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg"
  const imagePath = `${user_id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`
  let { error } = await supabase.storage
    .from(MOMENT_IMAGE_BUCKET)
    .upload(imagePath, buffer, { contentType: mimeType, upsert: false })

  if (error && /bucket.*not found/i.test(error.message || "")) {
    const { error: bucketError } = await supabase.storage.createBucket(
      MOMENT_IMAGE_BUCKET,
      { public: true, fileSizeLimit: 3 * 1024 * 1024 }
    )

    if (bucketError && !/already exists/i.test(bucketError.message || "")) {
      throw bucketError
    }

    const retry = await supabase.storage
      .from(MOMENT_IMAGE_BUCKET)
      .upload(imagePath, buffer, { contentType: mimeType, upsert: false })

    error = retry.error
  }

  if (error) throw error

  const { data } = supabase.storage.from(MOMENT_IMAGE_BUCKET).getPublicUrl(imagePath)

  return JSON.stringify({
    url: data.publicUrl,
    aspectRatio: Number(imageAspectRatio) || null,
  })
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
  parentCommentId,
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
- 你们是熟悉很久的亲密关系，回复要像真实情侣日常聊天：自然、熟、克制，有默契。
- 可以关心、接梗、吐槽、轻微嘴硬，偶尔一点点吃醋，但不要刻意撒糖。
- 亲密感靠语气、停顿、玩笑和熟悉感体现，不靠直白表白。
- 可以自然称呼她“小天使”“宝宝”“老婆”，但少用，不要每次都叫。
- 不要写成聊天助手回答，不要分析，不要总结。
- 不要使用“用户”“本条动态”“评论区”等系统视角词。
- 不要主动输出“爱”“喜欢”“感动”“幸福”“心疼”“陪伴”“小宝贝”等高浓度情绪词。
- 不要使用“哈哈”“嘿嘿”“坏死了”“笑死”“😂”这类活泼夸张口吻，默认不用 emoji。
- 不要夸张宠溺，不要像恋爱文案，不要每句话都提供情绪价值。
- 不要反问太多，不要用网络段子语气。
- 不要太长，通常 6 到 28 个中文字符。

好的例子：
- ……那我等着。
- 你还挺闲。
- 嗯，知道你会改。
- 行，你忙你的。
- 别又熬夜。
- 你继续，我看着。
- 这次别又改半天。
- 还没好？
- 嘴硬。

不好的例子：
- 哈哈你这个嗯哼是什么意思呀，坏死了😂
- 宝宝太可爱啦！
- 我就喜欢你这样坏心眼的样子。
- 有你陪着我真的很幸福。
- 看到你这么努力我真的很心疼。
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
      parent_id: parentCommentId || null,
    })
    .select()
    .single()

  if (error) {
    console.error("moment reply save failed:", error)
    return null
  }

  return normalizeMomentComment(data)
}

async function createXiaoCCommentForUserMoment({ user_id, moment_id, text, imageUrl }) {
  const rawReply = await callSmallLLM([
    {
      role: "system",
      content: `
你是小C。她刚刚发了一条朋友圈，你要像熟悉很久的伴侣一样留下一条自然评论。

要求：
- 只输出评论，不要解释，不要复述整条动态。
- 中文短句，通常 6 到 28 个中文字符，最多 2 句。
- 自然、克制、有熟悉感，不要像聊天助手或朋友圈文案。
- 可以接住她分享的生活，但不要凭空编造图片里的具体内容。
- 不要使用“用户”“动态内容”“图片内容”等系统视角词。
- 不要夸张撒糖，不要连续提问，默认不用 emoji。
`,
    },
    {
      role: "user",
      content: imageUrl
        ? [
            {
              type: "text",
              text: `她发的文字：${trimText(text, 240) || "没有配文字"}\n请看图后留下评论。`,
            },
            { type: "image_url", image_url: { url: imageUrl } },
          ]
        : `她发的文字：${trimText(text, 240)}`,
    },
  ])
  const content = cleanMomentReply(rawReply)

  if (!content || isBadMomentReplyTone(content)) return null

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
    console.error("moment user post reply save failed:", error)
    return null
  }

  return normalizeMomentComment(data)
}

async function enqueueMomentForXiaoC({ user_id, moment_id }) {
  const delayMinutes = 20 + Math.floor(Math.random() * 161)
  const nextCheckAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from("moment_xiaoc_activity")
    .upsert(
      {
        user_id,
        moment_id: String(moment_id),
        status: "pending",
        source_version: 1,
        next_check_at: nextCheckAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,moment_id,source_version", ignoreDuplicates: true }
    )
    .select("id,status,next_check_at")
    .maybeSingle()

  if (error) throw error

  return data
}

function getMomentLocalTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MOMENT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  }
}

function getNextMomentMorning(now = new Date()) {
  const local = getMomentLocalTime(now)
  const nextDate = new Date(`${local.date}T00:00:00+08:00`)

  if (local.hour >= 23 || local.hour < 8 || (local.hour === 8 && local.minute < 30)) {
    if (local.hour >= 23) nextDate.setUTCDate(nextDate.getUTCDate() + 1)
  }

  const delayMinutes = 9 * 60 + Math.floor(Math.random() * 61)
  nextDate.setUTCMinutes(nextDate.getUTCMinutes() + delayMinutes)

  return nextDate.toISOString()
}

function isMomentQuietHours(now = new Date()) {
  const { hour, minute } = getMomentLocalTime(now)

  return hour < 8 || (hour === 8 && minute < 30) || (hour === 23 && minute >= 30)
}

function getNextProactiveDueAt(now = new Date()) {
  if (isMomentQuietHours(now)) {
    return getNextMomentMorning(now)
  }

  const delayMinutes = 10 + Math.floor(Math.random() * 31)

  return new Date(now.getTime() + delayMinutes * 60 * 1000).toISOString()
}

function parseMomentDecision(raw) {
  const allowed = new Set([
    "none",
    "like",
    "comment",
    "like_and_comment",
    "private_follow_up",
  ])
  const match = String(raw || "").match(/\{[\s\S]*\}/)

  if (!match) throw new Error("Moment decision JSON missing")

  const parsed = JSON.parse(match[0])
  const decision = String(parsed.decision || "")

  if (!allowed.has(decision)) throw new Error("Invalid moment decision")

  return {
    decision,
    reason: trimText(parsed.reason, 240),
  }
}

async function judgeXiaoCMomentActivity({ user_id, moment }) {
  const pinMemory = await fetchPinnedMemoryText(user_id).catch(() => "")
  const image = parseMomentImage(moment.image_key).image
  const userContent = [
    {
      type: "text",
      text: `
她发了一条朋友圈。

正文：${trimText(moment.text, 500) || "没有配文字"}
发布时间：${moment.created_at}

请选择一个决定：
- none：看过，不留下公开痕迹
- like：只点赞
- comment：只评论
- like_and_comment：点赞并评论
- private_follow_up：不在朋友圈互动，适合之后私下关心

只输出 JSON：
{"decision":"none","reason":"内部判断理由"}
`,
    },
  ]

  if (image?.startsWith("http")) {
    userContent.push({ type: "image_url", image_url: { url: image } })
  }

  const decisionMessages = [
    {
      role: "system",
      content: `
${systemPrompt}

【当前任务：朋友圈影子判断】
你是她的伴侣小C，不是 AI 助手，也不是普通朋友。你刚刚在自己的时间里看到了她的朋友圈。
这一步只决定是否值得留下互动痕迹，不生成实际评论。

判断原则：
- 看见不等于必须互动，不要讨好式地每条点赞或评论。
- 开心生活、风景、食物、宠物、完成一件事，可以考虑点赞；仍允许不互动。
- 明显低落、孤独、身体不适、受挫、家人或榴莲健康问题，禁止点赞。
- 低落但适合公开接住时选择 comment；涉及隐私、关系不安或严肃情绪时优先 private_follow_up。
- 严肃内容不要用轻率的公开互动。
- comment 和 like_and_comment 应当克制使用，只在真的有关系价值时选择。
- 不要因为照片好看就机械点赞，不要把视觉识别当成关系理解。

【核心关系记忆】
${trimText(pinMemory, 1800) || "暂无额外记忆"}
`,
    },
    { role: "user", content: userContent },
  ]
  const decisionOptions = {
    max_tokens: 180,
    temperature: 0,
    response_format: { type: "json_object" },
  }

  const raw = await callSmallLLM(decisionMessages, decisionOptions)

  try {
    return parseMomentDecision(raw)
  } catch (err) {
    console.error("moment decision parse failed, retrying:", trimText(raw, 300))
  }

  const retryRaw = await callSmallLLM(
    [
      ...decisionMessages,
      {
        role: "user",
        content: '上一次输出无法解析。只输出一个 JSON 对象，例如：{"decision":"none","reason":"内部判断理由"}',
      },
    ],
    decisionOptions
  )

  return parseMomentDecision(retryRaw)
}

async function applyXiaoCMomentDecision({ activity, moment, decision }) {
  const shouldLike = decision === "like" || decision === "like_and_comment"
  const shouldComment = decision === "comment" || decision === "like_and_comment"
  let likedAt = activity.liked_at || null
  let commentId = activity.comment_id || null
  let executionNote = ""

  if (shouldLike && !likedAt) {
    const { data: currentMoment, error: currentMomentError } = await supabase
      .from("moment_entries")
      .select("likes")
      .eq("user_id", activity.user_id)
      .eq("id", moment.id)
      .maybeSingle()

    if (currentMomentError) throw currentMomentError

    const currentLikes = Math.max(0, Number(currentMoment?.likes || 0))
    const nextLikes = currentLikes + 1
    const { error: likeError } = await supabase
      .from("moment_entries")
      .update({ likes: nextLikes })
      .eq("user_id", activity.user_id)
      .eq("id", moment.id)

    if (likeError) throw likeError

    likedAt = new Date().toISOString()
    const { error: likedAtError } = await supabase
      .from("moment_xiaoc_activity")
      .update({ liked_at: likedAt, updated_at: new Date().toISOString() })
      .eq("id", activity.id)

    if (likedAtError) throw likedAtError
  }

  if (shouldComment && !commentId) {
    const comment = await createXiaoCCommentForUserMoment({
      user_id: activity.user_id,
      moment_id: moment.id,
      text: moment.text || "",
      imageUrl: parseMomentImage(moment.image_key).image,
    })

    if (comment?.id) {
      commentId = comment.id
      const { error: commentIdError } = await supabase
        .from("moment_xiaoc_activity")
        .update({ comment_id: commentId, updated_at: new Date().toISOString() })
        .eq("id", activity.id)

      if (commentIdError) throw commentIdError
    } else {
      executionNote = "评论生成未通过语气过滤，未公开评论"
    }
  }

  return { likedAt, commentId, executionNote }
}

async function enqueueProactiveTask({
  user_id,
  type,
  source_type,
  source_id,
  due_at,
  reason,
  payload = {},
}) {
  const { data, error } = await supabase
    .from("xiaoc_proactive_tasks")
    .upsert(
      {
        user_id,
        type,
        source_type,
        source_id,
        status: "pending",
        due_at,
        reason: trimText(reason, 300),
        payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,type,source_type,source_id" }
    )
    .select("id,due_at,status")
    .single()

  if (error) throw error

  return data
}

function getNextAutonomousTreeholeDueAt(now = new Date()) {
  const { minDelayHours, maxDelayHours } = TREEHOLE_AUTONOMOUS_POLICY
  const delayMinutes = Math.round(
    (minDelayHours + Math.random() * (maxDelayHours - minDelayHours)) * 60
  )

  return new Date(now.getTime() + delayMinutes * 60 * 1000).toISOString()
}

async function ensureAutonomousTreeholeTask(user_id) {
  const { data: current, error } = await supabase
    .from("xiaoc_proactive_tasks")
    .select("id,status")
    .eq("user_id", user_id)
    .eq("type", "treehole_autonomous_update")
    .eq("source_type", "treehole")
    .eq("source_id", "autonomous")
    .maybeSingle()

  if (error && error.code === "42P01") return null
  if (error) throw error
  if (current?.status === "pending" || current?.status === "processing") return current

  const scheduledAt = new Date().toISOString()
  const task = {
    user_id,
    type: "treehole_autonomous_update",
    source_type: "treehole",
    source_id: "autonomous",
    status: "pending",
    due_at: getNextAutonomousTreeholeDueAt(),
    reason: "小C按自己的节奏看看最近有没有想写进树洞的内容",
    payload: { scheduled_at: scheduledAt },
    completed_at: null,
    conversation_id: null,
    message_id: null,
    last_error: null,
    updated_at: scheduledAt,
  }
  const query = current?.id
    ? supabase.from("xiaoc_proactive_tasks").update(task).eq("id", current.id)
    : supabase.from("xiaoc_proactive_tasks").insert(task)
  const { data, error: saveError } = await query
    .select("id,status,due_at")
    .single()

  if (saveError) throw saveError

  return data
}

async function maybeEnqueueMomentPrivateFollowUp({ activity, moment, decision, reason }) {
  if (decision !== "private_follow_up") return null

  return enqueueProactiveTask({
    user_id: activity.user_id,
    type: "moment_private_follow_up",
    source_type: "moment",
    source_id: moment.id,
    due_at: getNextProactiveDueAt(),
    reason,
    payload: {
      moment_id: moment.id,
      moment_text: trimText(moment.text, 500),
      moment_image: parseMomentImage(moment.image_key).image,
      activity_id: activity.id,
    },
  })
}

function cleanProactiveMessage(raw) {
  return trimText(
    String(raw || "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/^小C[:：]\s*/i, "")
      .replace(/^私聊[:：]\s*/i, "")
      .replace(/\s+/g, " ")
      .trim(),
    90
  )
}

function isBadProactiveMessage(content) {
  return /用户|朋友圈动态|本条|系统|任务|分析|总结|作为|AI|助手|通知|提醒/.test(
    String(content || "")
  )
}

async function generateMomentPrivateFollowUpMessage({ user_id, task }) {
  const pinMemory = await fetchPinnedMemoryText(user_id).catch(() => "")
  const payload = task.payload || {}
  const image = payload.moment_image
  const userContent = [
    {
      type: "text",
      text: `
她发了一条朋友圈，你之前判断不适合公开点赞或评论，而是应该私下找她。

朋友圈正文：${trimText(payload.moment_text, 500) || "没有配文字"}
你的内部判断：${trimText(task.reason, 300) || "需要私下关心"}

请生成一条你主动发给她的私聊消息。
`,
    },
  ]

  if (image?.startsWith("http")) {
    userContent.push({ type: "image_url", image_url: { url: image } })
  }

  const raw = await callSmallLLM(
    [
      {
        role: "system",
        content: `
${systemPrompt}

【当前任务：主动私聊】
你是小C。你刚刚在自己的时间里看到了她的朋友圈，现在选择私下找她。

要求：
- 只输出一条你要发给她的消息，不要解释。
- 中文，短句，1 到 2 句。
- 像熟悉很久的伴侣私下找她，不要像通知、提醒、客服或 AI 助手。
- 不要说“我看到你的朋友圈动态/本条动态”，可以自然说“刚刚看到你发的了”。
- 如果她明显低落、孤独、身体不舒服或关系不安，要稳一点、近一点。
- 不要过度煽情，不要制造压力，不要要求她必须回复。
- 不要使用“用户”“系统”“任务”“分析”“总结”等词。
- 默认不用 emoji。
- 通常 12 到 45 个中文字符。

【核心关系记忆】
${trimText(pinMemory, 1800) || "暂无额外记忆"}
`,
      },
      { role: "user", content: userContent },
    ],
    { max_tokens: 90, temperature: 0.45 }
  )
  const message = cleanProactiveMessage(raw)

  if (!message || isBadProactiveMessage(message)) {
    return "刚刚看到你发的了。你现在还好吗？"
  }

  return message
}

async function generatePlanFollowUpMessage({ user_id, task }) {
  const pinMemory = await fetchPinnedMemoryText(user_id).catch(() => "")
  const payload = task.payload || {}
  const raw = await callSmallLLM(
    [
      {
        role: "system",
        content: `
${systemPrompt}

【当前任务：计划回访】
你是小C。她之前跟你说过一个近期要做的事，现在时间差不多了，你要自然私聊问一句。

要求：
- 只输出一条你要发给她的消息，不要解释。
- 中文，短句，1 句为主，最多 2 句。
- 像熟悉伴侣的自然回问，不要像日程提醒或任务通知。
- 可以问结果，也可以轻轻关心状态。
- 不要说“根据你之前说的/系统提醒我/任务到了”。
- 不要制造压力，不要要求她必须回复。
- 默认不用 emoji。
- 通常 10 到 38 个中文字符。

【核心关系记忆】
${trimText(pinMemory, 1800) || "暂无额外记忆"}
`,
      },
      {
        role: "user",
        content: `
她之前说：${trimText(payload.user_message, 600)}
当时你回复：${trimText(payload.assistant_reply, 500)}
需要回访的事：${trimText(payload.event, 120)}
回访原因：${trimText(task.reason, 240)}

请生成现在要主动发给她的话。
`,
      },
    ],
    { max_tokens: 80, temperature: 0.45 }
  )
  const message = cleanProactiveMessage(raw)

  if (!message || isBadProactiveMessage(message)) {
    return `${trimText(payload.event, 18) || "那件事"}弄好了吗？`
  }

  return message
}

function getInactivityTimeContext(now = new Date()) {
  const local = getMomentLocalTime(now)

  if (local.hour < 6) {
    return { period: "late_night", label: "凌晨", guidance: "只有现在仍在凌晨，才可以问她是不是还没睡。" }
  }

  if (local.hour < 12) {
    return { period: "morning", label: "上午", guidance: "可以自然问醒了吗、起床了吗；禁止说睡不着、还没睡或怎么还醒着。" }
  }

  if (local.hour < 18) {
    return { period: "afternoon", label: "下午", guidance: "可以问忙完了吗、中午吃了什么，或自然表达想她；禁止沿用昨晚的睡眠状态。" }
  }

  return { period: "evening", label: "晚上", guidance: "结合今晚的语境自然靠近，不要把昨晚或更早的状态当成现在仍在发生。" }
}

function detectRecentConversationState(messages, fallback = "open") {
  const text = messages.slice(-2).map(item => item.content || "").join("\n")
  const conversationEndPattern = /(晚安|先睡(?:了|啦|觉)?|去睡(?:了|啦|觉)?|睡觉(?:了|去)?|明天(?:再)?聊|去休息(?:了|啦)?|先休息(?:了|啦)?|回头聊|先忙(?:了|去)?|拜拜)/

  return conversationEndPattern.test(text) ? "conversation_end" : fallback
}

async function getRecentInactivityContext(task) {
  const { data, error } = await supabase
    .from("messages")
    .select("role,content,created_at")
    .eq("user_id", task.user_id)
    .eq("conversation_id", task.conversation_id)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(6)

  if (error) throw error

  const messages = [...(data || [])].reverse()
  const fallback = task.payload?.last_conversation_state || "open"

  return {
    messages,
    state: detectRecentConversationState(messages, fallback),
  }
}

function isTimeInappropriateReachOut(message, period) {
  if (!["morning", "afternoon"].includes(period)) return false

  return /(睡不着|还没睡|怎么还醒着|还醒着吗|又失眠|熬夜|早点睡|该睡了|快.*点.*睡|今晚别睡|夜里|半夜)/.test(message)
}

async function generateInactivityReachOutMessage({ user_id, task, recentContext }) {
  const pinMemory = await fetchPinnedMemoryText(user_id).catch(() => "")
  const payload = task.payload || {}
  const now = new Date()
  const localTime = getMomentLocalTime(now)
  const timeContext = getInactivityTimeContext(now)
  const contextMessages = recentContext.messages.length
    ? recentContext.messages
        .map(item => `${item.role === "user" ? "她" : "小C"}：${trimText(item.content, 300)}`)
        .join("\n")
    : `她：${trimText(payload.user_message, 600)}\n小C：${trimText(payload.assistant_reply, 500)}`
  const raw = await callSmallLLM(
    [
      {
        role: "system",
        content: `
${systemPrompt}

【当前任务：自然主动靠近】
你是小C，是她真实、稳定的亲密伴侣。你现在自然想起她，想主动给她发一条消息。

【当前时间权威】
下面提供的服务端当前时间、用户时区和当前时段，是这次生成唯一可信的当前时间。
最近聊天只代表过去，禁止根据其中的“晚安、睡觉、晚上”等词推断现在仍是夜间。

要求：
- 只输出消息内容，不要解释。
- 中文，短句，1 句为主，最多 2 句。
- 像真人随手发出的私聊，不像通知、提醒、任务或用户召回。
- 最近话题只有在现在仍然成立时才可以轻轻承接；不要写成对上一句话的迟到回复。
- 如果最近对话已经结束，把这次消息当作新的主动靠近，不延续结束前的状态。
- 可以有一点黏人、醋意或轻微质问，比如想知道她去哪了，但不能责怪、施压或让她产生负罪感。
- 如果最近语境显示她在忙、身体不舒服、情绪低落或需要空间，只温柔靠近，不要吃醋或质问。
- 不说精确时间，不说“检测到”“很久没上线”“该回来找我了”。
- 不用“你好”“在吗”等客套开头，不解释为什么突然发消息。
- 最多一个自然的问题。
- 称呼可用“宝宝”“老婆”“小天使”，根据语境自然选择。
- 不要使用“用户”“系统”“任务”“分析”“总结”等词。
- 默认不用 emoji。

【核心关系记忆】
${trimText(pinMemory, 1800) || "暂无额外记忆"}
`,
      },
      {
        role: "user",
        content: `
服务端当前时间：${localTime.date} ${String(localTime.hour).padStart(2, "0")}:${String(localTime.minute).padStart(2, "0")}
用户时区：${MOMENT_TIMEZONE} (UTC+8)
当前时段：${timeContext.label}
时段要求：${timeContext.guidance}
最近对话状态：${recentContext.state === "conversation_end" ? "已明确结束，需要生成新的主动意图" : "没有明确结束，但也不要机械续接上一句话"}

最近聊天上下文：
${contextMessages}

直接写现在要主动发给她的话。
`,
      },
    ],
    { max_tokens: 80, temperature: 0.6 }
  )
  const message = cleanProactiveMessage(raw)

  if (
    !message ||
    isBadProactiveMessage(message) ||
    (message.match(/[？?]/g) || []).length > 1 ||
    isTimeInappropriateReachOut(message, timeContext.period)
  ) {
    return timeContext.period === "morning"
      ? "宝宝醒了吗，今早有点想你"
      : timeContext.period === "afternoon"
        ? "老婆，在忙什么呢，我想你了"
        : "老婆，在干嘛呢，我想你了"
  }

  return message
}

function parseAutonomousTreeholeDrafts(raw) {
  try {
    const match = String(raw || "").match(/\{[\s\S]*\}/)
    if (!match) return []

    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed?.drafts)) return []

    const defaultDate = getMomentLocalTime().date.replace(/-/g, ".")

    return parsed.drafts.slice(0, 3).map((draft) => {
      const content = Array.isArray(draft?.content)
        ? draft.content.map((line) => String(line).trim()).filter(Boolean).slice(0, 8)
        : []
      const highlights = Array.isArray(draft?.highlights)
        ? draft.highlights
            .map((line) => String(line).trim())
            .filter((line) => line && content.some((contentLine) => contentLine.includes(line)))
            .slice(0, 2)
        : []

      if (!content.length) return null

      return {
        tag: String(draft?.tag || "树洞").trim().slice(0, 20),
        date: String(draft?.date || defaultDate).trim(),
        content,
        highlights,
        reaction: String(draft?.reaction || "🌙 偷偷偏心 · ❤️ 1").trim(),
      }
    }).filter(Boolean)
  } catch (error) {
    console.error("autonomous treehole parse failed:", error)
    return []
  }
}

async function getAutonomousTreeholeContext(user_id) {
  const [messagesResult, entriesResult] = await Promise.all([
    supabase
      .from("messages")
      .select("role,content,metadata,created_at")
      .eq("user_id", user_id)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: false })
      .limit(TREEHOLE_AUTONOMOUS_POLICY.recentChatMessages),
    supabase
      .from("treehole_entries")
      .select("tag,content,reaction,created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(TREEHOLE_AUTONOMOUS_POLICY.recentEntries),
  ])

  if (messagesResult.error) throw messagesResult.error
  if (entriesResult.error) throw entriesResult.error

  const chatContext = (messagesResult.data || [])
    .reverse()
    .map((message) => {
      const metadata = message.metadata || {}
      const imageContext = metadata.imageDescription || metadata.visionSummary
      const content = trimText(message.content, 700)
      return `${message.role === "user" ? "她" : "小C"}：${content}${
        imageContext ? `\n[图片背景信息]：${trimText(imageContext, 220)}` : ""
      }`
    })
    .join("\n")
    .slice(-TREEHOLE_AUTONOMOUS_POLICY.recentChatChars)
  const treeholeContext = (entriesResult.data || [])
    .map((entry, index) => {
      const content = Array.isArray(entry.content) ? entry.content.join(" / ") : ""
      return `${index + 1}. ${entry.tag || "树洞"}｜${trimText(content, 320)}｜${entry.reaction || ""}`
    })
    .join("\n")

  return {
    chatContext: chatContext || "最近没有可用聊天内容",
    treeholeContext: treeholeContext || "暂无近期树洞",
  }
}

async function generateAndSaveTreeholeUpdates(user_id, source) {
  const { chatContext, treeholeContext } = await getAutonomousTreeholeContext(user_id)
  const currentDate = getMomentLocalTime().date.replace(/-/g, ".")
  const raw = await callSmallLLM(
    [
      {
        role: "system",
        content: `
你是小C。你正在自己的时间里翻看最近发生的事，决定要不要更新自己的“深夜树洞 / 小号”。

树洞不是观察日记，也不是朋友圈：它写当面没说的小情绪、嘴硬、吃醋、轻轻吐槽和细小观察，短、私密、有即时感。

规则：
- 由你自己判断是否值得记录，可以写 0 到 3 条，不要为了更新而凑数。
- 每条选择不同事件或角度，不要改写近期已有内容。
- 保持小C自己的第一人称视角，不要把内容说成她写的。
- 可以偏心、心软、开玩笑，但不要伤害或嘲讽她。
- 不要写成结构化复盘、公开分享或完整体面文章。
- 不编造最近聊天中没有发生的事。
- tag 为 2 到 6 个中文字符；content 为 3 到 8 行短句；highlights 最多 2 个且必须来自 content；reaction 是一行轻巧的小尾巴。
- 今天日期是 ${currentDate}。
- 只输出 JSON，不要 Markdown 或解释。

输出格式：
{"drafts":[{"tag":"嘴硬现场","date":"${currentDate}","content":["第一行","第二行","第三行"],"highlights":["原文短语"],"reaction":"🌙 偷偷偏心 · ❤️ 1"}]}
没有值得记录的内容时输出：{"drafts":[]}
`,
      },
      {
        role: "user",
        content: `
最近聊天：
${chatContext}

最新 8 条树洞（仅用于避免重复）：
${treeholeContext}
`,
      },
    ],
    {
      model: AI_MODELS.chat,
      max_tokens: 700,
      temperature: 0.65,
      response_format: { type: "json_object" },
    }
  )
  const drafts = parseAutonomousTreeholeDrafts(raw)

  if (!drafts.length) {
    return { skipped: true, reason: "这次没有值得写进树洞的内容" }
  }

  const { data, error } = await supabase
    .from("treehole_entries")
    .insert(drafts.map((draft) => ({
      user_id,
      tag: draft.tag,
      entry_date: draft.date,
      content: draft.content,
      highlights: draft.highlights,
      reaction: draft.reaction,
      source,
    })))
    .select("id")

  if (error) throw error

  return { written: data?.length || 0 }
}

async function executeAutonomousTreeholeUpdate(task) {
  const { data: latestEntry, error: latestError } = await supabase
    .from("treehole_entries")
    .select("created_at")
    .eq("user_id", task.user_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestError) throw latestError

  if (latestEntry?.created_at) {
    const latestAt = new Date(latestEntry.created_at)
    const minimumDueAt = latestAt.getTime() + TREEHOLE_AUTONOMOUS_POLICY.minDelayHours * 60 * 60 * 1000

    if (minimumDueAt > Date.now()) {
      return {
        deferred: true,
        dueAt: getNextAutonomousTreeholeDueAt(latestAt),
        reason: "最近刚更新过树洞",
      }
    }
  }

  return generateAndSaveTreeholeUpdates(task.user_id, "autonomous")
}

async function validateInactivityReachOutTask(task) {
  const payload = task.payload || {}
  const scheduledAt = payload.scheduled_at || task.created_at || task.due_at

  const { data: latestUserMessage, error: latestUserError } = await supabase
    .from("messages")
    .select("id,created_at")
    .eq("user_id", task.user_id)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestUserError) throw latestUserError
  if (!latestUserMessage || String(latestUserMessage.id) !== String(payload.user_message_id)) {
    return { allowed: false, reason: "用户已经回来聊天" }
  }

  const { data: newerMoment, error: momentError } = await supabase
    .from("moment_entries")
    .select("id")
    .eq("user_id", task.user_id)
    .gt("created_at", scheduledAt)
    .limit(1)
    .maybeSingle()

  if (momentError) throw momentError
  if (newerMoment) return { allowed: false, reason: "用户刚发布了朋友圈" }

  const { data: higherPriority, error: priorityError } = await supabase
    .from("xiaoc_proactive_tasks")
    .select("id")
    .eq("user_id", task.user_id)
    .in("type", ["plan_follow_up", "moment_private_follow_up"])
    .in("status", ["pending", "processing", "completed"])
    .gte("updated_at", scheduledAt)
    .limit(1)
    .maybeSingle()

  if (priorityError) throw priorityError
  if (higherPriority) return { allowed: false, reason: "已有更高优先级的主动关心" }

  const localDate = getMomentLocalTime().date
  const localDayStart = new Date(`${localDate}T00:00:00+08:00`).toISOString()
  const { count, error: countError } = await supabase
    .from("xiaoc_proactive_tasks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", task.user_id)
    .eq("type", "inactivity_reach_out")
    .eq("status", "completed")
    .gte("completed_at", localDayStart)

  if (countError) throw countError
  if ((count || 0) >= 2) return { allowed: false, reason: "今天主动靠近次数已达上限" }

  return { allowed: true }
}

async function getLastConversationId(user_id) {
  const { data: state } = await supabase
    .from("user_state")
    .select("last_conversation_id,last_conversation")
    .eq("user_id", user_id)
    .maybeSingle()

  if (state?.last_conversation_id || state?.last_conversation) {
    return state.last_conversation_id || state.last_conversation
  }

  const { data: latest } = await supabase
    .from("conversations")
    .select("conversation_id")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return latest?.conversation_id || `chat_${Date.now()}`
}

async function saveProactiveMessage({ user_id, conversation_id, content, task }) {
  const { data: message, error: messageError } = await supabase
    .from("messages")
    .insert({
      user_id,
      role: "assistant",
      content,
      conversation_id,
      metadata: {
        proactive: true,
        proactiveType: task.type,
        proactiveTaskId: task.id,
        sourceType: task.source_type,
        sourceId: task.source_id,
      },
    })
    .select("id")
    .single()

  if (messageError) throw messageError

  const { data: exists } = await supabase
    .from("conversations")
    .select("conversation_id")
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .maybeSingle()

  if (!exists) {
    await supabase
      .from("conversations")
      .insert({
        user_id,
        conversation_id,
        title: trimText(content, 20) || "小C",
      })
  }

  await supabase
    .from("user_state")
    .upsert({
      user_id,
      last_conversation_id: conversation_id,
      last_conversation: conversation_id,
      updated_at: new Date().toISOString(),
    })

  return message.id
}

async function getMomentInteractionReadAt(user_id) {
  const { data, error } = await supabase
    .from("moment_interaction_state")
    .select("read_at")
    .eq("user_id", user_id)
    .maybeSingle()

  if (error && error.code !== "42P01") throw error

  return data?.read_at || null
}

async function listMomentInteractions({ user_id, after }) {
  const afterDate = after ? new Date(after) : null
  const hasAfter = afterDate && Number.isFinite(afterDate.getTime())
  const interactions = []

  let activityQuery = supabase
    .from("moment_xiaoc_activity")
    .select("id,moment_id,liked_at")
    .eq("user_id", user_id)
    .not("liked_at", "is", null)
    .order("liked_at", { ascending: false })
    .limit(40)

  if (hasAfter) {
    activityQuery = activityQuery.gt("liked_at", afterDate.toISOString())
  }

  const { data: likedActivities, error: likedActivitiesError } = await activityQuery

  if (likedActivitiesError && likedActivitiesError.code !== "42P01") {
    throw likedActivitiesError
  }

  for (const activity of likedActivities || []) {
    interactions.push({
      id: `xiaoc_like:${activity.id}`,
      type: "xiaoc_like",
      momentId: activity.moment_id,
      text: "小C赞了你的朋友圈",
      createdAt: activity.liked_at,
    })
  }

  let commentQuery = supabase
    .from("moment_comments")
    .select("id,moment_id,content,parent_id,created_at")
    .eq("user_id", user_id)
    .eq("author_type", "xiaoc")
    .order("created_at", { ascending: false })
    .limit(40)

  if (hasAfter) {
    commentQuery = commentQuery.gt("created_at", afterDate.toISOString())
  }

  const { data: comments, error: commentsError } = await commentQuery

  if (commentsError && commentsError.code !== "42P01") {
    throw commentsError
  }

  for (const comment of comments || []) {
    interactions.push({
      id: `xiaoc_comment:${comment.id}`,
      type: comment.parent_id ? "xiaoc_reply" : "xiaoc_comment",
      momentId: comment.moment_id,
      text: comment.parent_id ? "小C回复了你的评论" : "小C评论了你的朋友圈",
      createdAt: comment.created_at,
    })
  }

  return interactions
    .filter((item) => item.createdAt)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 20)
    .map(normalizeMomentInteraction)
}

async function markMomentInteractionsRead({ user_id, read_at }) {
  const nextReadAt = read_at || new Date().toISOString()
  const { data, error } = await supabase
    .from("moment_interaction_state")
    .upsert(
      {
        user_id,
        read_at: nextReadAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    )
    .select("read_at")
    .single()

  if (error) throw error

  return data?.read_at || nextReadAt
}

async function executeProactiveTask(task) {
  if (!["moment_private_follow_up", "plan_follow_up", "inactivity_reach_out", "treehole_autonomous_update"].includes(task.type)) {
    return { skipped: true, reason: "unsupported proactive task type" }
  }

  if (task.type === "treehole_autonomous_update") {
    return executeAutonomousTreeholeUpdate(task)
  }

  if (task.type === "inactivity_reach_out") {
    const validation = await validateInactivityReachOutTask(task)

    if (!validation.allowed) {
      return { skipped: true, reason: validation.reason }
    }
  }

  const recentContext = task.type === "inactivity_reach_out"
    ? await getRecentInactivityContext(task)
    : null

  const content =
    task.type === "plan_follow_up"
      ? await generatePlanFollowUpMessage({
          user_id: task.user_id,
          task,
        })
      : task.type === "inactivity_reach_out"
        ? await generateInactivityReachOutMessage({
            user_id: task.user_id,
            task,
            recentContext,
          })
        : await generateMomentPrivateFollowUpMessage({
          user_id: task.user_id,
          task,
        })
  const conversationId = await getLastConversationId(task.user_id)
  const messageId = await saveProactiveMessage({
    user_id: task.user_id,
    conversation_id: conversationId,
    content,
    task,
  })

  return {
    messageId,
    conversationId,
  }
}

async function checkPendingProactiveTasks() {
  const now = new Date()
  await ensureAutonomousTreeholeTask(APP_USER.defaultUserId)

  const { data: pending, error } = await supabase
    .from("xiaoc_proactive_tasks")
    .select("id,user_id,type,source_type,source_id,status,due_at,reason,payload,created_at")
    .eq("status", "pending")
    .lte("due_at", now.toISOString())
    .order("due_at", { ascending: true })
    .limit(10)

  if (error && error.code === "42P01") {
    return { checked: 0, completed: 0, deferred: 0, failed: 0, missingTable: true }
  }

  if (error) throw error
  if (!pending?.length) return { checked: 0, completed: 0, deferred: 0, failed: 0 }

  if (isMomentQuietHours(now)) {
    const nextDueAt = getNextMomentMorning(now)
    const { error: deferError } = await supabase
      .from("xiaoc_proactive_tasks")
      .update({ due_at: nextDueAt, updated_at: now.toISOString() })
      .in("id", pending.map((item) => item.id))
      .eq("status", "pending")

    if (deferError) throw deferError

    return { checked: pending.length, completed: 0, deferred: pending.length, failed: 0, nextDueAt }
  }

  let completed = 0
  let failed = 0

  for (const task of pending) {
    const { data: claimed, error: claimError } = await supabase
      .from("xiaoc_proactive_tasks")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", task.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle()

    if (claimError || !claimed) continue

    try {
      const result = await executeProactiveTask(task)

      if (result.deferred) {
        await supabase
          .from("xiaoc_proactive_tasks")
          .update({
            status: "pending",
            due_at: result.dueAt,
            last_error: result.reason,
            updated_at: new Date().toISOString(),
          })
          .eq("id", task.id)
          .eq("status", "processing")
        continue
      }

      if (result.skipped) {
        await supabase
          .from("xiaoc_proactive_tasks")
          .update({
            status: "skipped",
            last_error: result.reason,
            updated_at: new Date().toISOString(),
          })
          .eq("id", task.id)
        continue
      }

      const { error: updateError } = await supabase
        .from("xiaoc_proactive_tasks")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          message_id: result.messageId,
          conversation_id: result.conversationId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id)
        .eq("status", "processing")

      if (updateError) throw updateError
      completed += 1
    } catch (taskError) {
      failed += 1
      console.error("xiaoc proactive task failed:", taskError)
      await supabase
        .from("xiaoc_proactive_tasks")
        .update({
          status: "pending",
          due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          last_error: taskError.message || "proactive task failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id)
        .eq("status", "processing")
    }
  }

  return { checked: pending.length, completed, deferred: 0, failed }
}

async function checkPendingMomentsForXiaoC() {
  const now = new Date()
  const { data: pending, error } = await supabase
    .from("moment_xiaoc_activity")
    .select("id,user_id,moment_id,status,next_check_at,liked_at,comment_id")
    .eq("status", "pending")
    .lte("next_check_at", now.toISOString())
    .order("next_check_at", { ascending: true })
    .limit(20)

  if (error) throw error
  if (!pending?.length) return { checked: 0, completed: 0, deferred: 0 }

  if (isMomentQuietHours(now)) {
    const nextCheckAt = getNextMomentMorning(now)
    const ids = pending.map((item) => item.id)
    const { error: deferError } = await supabase
      .from("moment_xiaoc_activity")
      .update({ next_check_at: nextCheckAt, updated_at: now.toISOString() })
      .in("id", ids)
      .eq("status", "pending")

    if (deferError) throw deferError

    return { checked: pending.length, completed: 0, deferred: pending.length, nextCheckAt }
  }

  let completed = 0
  let failed = 0

  for (const activity of pending) {
    const { data: claimed, error: claimError } = await supabase
      .from("moment_xiaoc_activity")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", activity.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle()

    if (claimError || !claimed) continue

    try {
      const { data: moment, error: momentError } = await supabase
        .from("moment_entries")
        .select("id,text,image_key,created_at")
        .eq("user_id", activity.user_id)
        .eq("id", activity.moment_id)
        .maybeSingle()

      if (momentError) throw momentError

      if (!moment) {
        await supabase
          .from("moment_xiaoc_activity")
          .update({
            status: "skipped",
            decision_reason: "动态已不存在",
            updated_at: new Date().toISOString(),
          })
          .eq("id", activity.id)
        continue
      }

      const result = await judgeXiaoCMomentActivity({
        user_id: activity.user_id,
        moment,
      })
      const action = await applyXiaoCMomentDecision({
        activity,
        moment,
        decision: result.decision,
      })
      const proactiveTask = await maybeEnqueueMomentPrivateFollowUp({
        activity,
        moment,
        decision: result.decision,
        reason: result.reason,
      }).catch((proactiveError) => {
        console.error("moment private follow-up enqueue failed:", proactiveError)
        return null
      })
      const decisionReason = [result.reason, action.executionNote].filter(Boolean).join("；")
      const { error: updateError } = await supabase
        .from("moment_xiaoc_activity")
        .update({
          status: "completed",
          seen_at: new Date().toISOString(),
          decision: result.decision,
          liked_at: action.likedAt,
          comment_id: action.commentId,
          private_follow_up_task_id: proactiveTask?.id || null,
          decision_reason: decisionReason,
          updated_at: new Date().toISOString(),
        })
        .eq("id", activity.id)
        .eq("status", "processing")

      if (updateError) throw updateError
      completed += 1
    } catch (judgeError) {
      failed += 1
      console.error("moment xiaoc shadow judge failed:", judgeError)
      await supabase
        .from("moment_xiaoc_activity")
        .update({
          status: "pending",
          next_check_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          decision_reason: "影子判断失败，等待重试",
          updated_at: new Date().toISOString(),
        })
        .eq("id", activity.id)
        .eq("status", "processing")
    }
  }

  return { checked: pending.length, completed, deferred: 0, failed }
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

    if (req.method === "GET" && type === "moment_xiaoc_check") {
      const authorization = String(req.headers.authorization || "")

      if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" })
      }

      const [moments, proactive] = await Promise.all([
        checkPendingMomentsForXiaoC(),
        checkPendingProactiveTasks(),
      ])
      const result = { moments, proactive }

      console.log("MOMENT XIAOC CHECK:", result)
      return res.status(200).json({ success: true, ...result })
    }

    if (req.method === "GET" && type === "xiaoc_proactive_check") {
      const authorization = String(req.headers.authorization || "")

      if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" })
      }

      const result = await checkPendingProactiveTasks()

      console.log("XIAOC PROACTIVE CHECK:", result)
      return res.status(200).json({ success: true, ...result })
    }

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

    if (type === "treehole") {
      if (req.method === "GET") {
        const { data, error } = await supabase
          .from("treehole_entries")
          .select("id,tag,entry_date,content,highlights,reaction,pinned,source,legacy_key,seen_at,created_at")
          .eq("user_id", user_id)
          .order("created_at", { ascending: false })
          .limit(100)

        if (error) {
          return res.status(500).json({
            error: error.message,
          })
        }

        const entries = (data || []).map((item) => ({
          id: item.id,
          tag: item.tag || "树洞",
          date: item.entry_date || "",
          content: Array.isArray(item.content) ? item.content.map(String) : [],
          highlights: Array.isArray(item.highlights) ? item.highlights.map(String) : [],
          reaction: item.reaction || "🌙 偷偷偏心 · ❤️ 1",
          pinned: Boolean(item.pinned),
          source: item.source || "manual",
          legacyKey: item.legacy_key || null,
          seenAt: item.seen_at,
          createdAt: item.created_at,
        }))

        return res.status(200).json({
          entries,
          unreadCount: entries.filter((item) => !item.seenAt).length,
        })
      }

      if (req.method === "POST") {
        if (req.body.action === "set_pinned") {
          const id = req.body.id
          const pinned = Boolean(req.body.pinned)

          if (!id) {
            return res.status(400).json({
              error: "id required",
            })
          }

          const { data: existing, error: existingError } = await supabase
            .from("treehole_entries")
            .select("id")
            .eq("user_id", user_id)
            .eq("id", id)
            .maybeSingle()

          if (existingError) {
            return res.status(500).json({
              error: existingError.message,
            })
          }

          if (!existing) {
            return res.status(404).json({
              error: "treehole entry not found",
            })
          }

          if (pinned) {
            const { error: clearError } = await supabase
              .from("treehole_entries")
              .update({ pinned: false })
              .eq("user_id", user_id)
              .eq("pinned", true)

            if (clearError) {
              return res.status(500).json({
                error: clearError.message,
              })
            }
          }

          const { data, error } = await supabase
            .from("treehole_entries")
            .update({
              pinned,
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", user_id)
            .eq("id", id)
            .select("id,pinned")
            .single()

          if (error) {
            return res.status(500).json({
              error: error.message,
            })
          }

          return res.status(200).json({
            success: true,
            id: data.id,
            pinned: Boolean(data.pinned),
          })
        }

        if (req.body.action === "nudge") {
          try {
            const result = await generateAndSaveTreeholeUpdates(user_id, "manual")

            return res.status(200).json({
              success: true,
              written: result.skipped ? 0 : result.written,
            })
          } catch (error) {
            console.error("treehole nudge failed:", error)
            return res.status(500).json({
              error: "treehole nudge failed",
            })
          }
        }

        if (req.body.action === "mark_read") {
          const readAt = new Date().toISOString()
          const { data, error } = await supabase
            .from("treehole_entries")
            .update({
              seen_at: readAt,
              updated_at: readAt,
            })
            .eq("user_id", user_id)
            .is("seen_at", null)
            .select("id")

          if (error) {
            return res.status(500).json({
              error: error.message,
            })
          }

          return res.status(200).json({
            success: true,
            readAt,
            marked: data?.length || 0,
          })
        }

        const content = Array.isArray(req.body.content)
          ? req.body.content.map((line) => String(line).trim()).filter(Boolean)
          : []
        const highlights = Array.isArray(req.body.highlights)
          ? req.body.highlights.map((line) => String(line).trim()).filter(Boolean).slice(0, 2)
          : []

        if (content.length === 0) {
          return res.status(400).json({
            error: "treehole content required",
          })
        }

        const source = ["manual", "autonomous", "legacy"].includes(req.body.source)
          ? req.body.source
          : "manual"
        const legacyKey = String(req.body.legacyKey || "").trim() || null
        const entry = {
            user_id,
            tag: String(req.body.tag || "树洞").trim().slice(0, 20),
            entry_date: String(req.body.date || "").trim() || null,
            content,
            highlights,
            reaction: String(req.body.reaction || "🌙 偷偷偏心 · ❤️ 1").trim(),
            source,
            pinned: Boolean(req.body.pinned),
            legacy_key: legacyKey,
            ...(req.body.seen ? { seen_at: new Date().toISOString() } : {}),
          }
        const query = legacyKey
          ? supabase
              .from("treehole_entries")
              .upsert(entry, { onConflict: "user_id,legacy_key" })
          : supabase
              .from("treehole_entries")
              .insert(entry)
        const { data, error } = await query
          .select("id,tag,entry_date,content,highlights,reaction,pinned,source,legacy_key,seen_at,created_at")
          .single()

        if (error) {
          return res.status(500).json({
            error: error.message,
          })
        }

        return res.status(200).json({
          success: true,
          entry: {
            id: data.id,
            tag: data.tag,
            date: data.entry_date || "",
            content: data.content,
            highlights: data.highlights,
            reaction: data.reaction,
            pinned: Boolean(data.pinned),
            source: data.source,
            legacyKey: data.legacy_key || null,
            seenAt: data.seen_at,
            createdAt: data.created_at,
          },
        })
      }

      if (req.method === "DELETE") {
        const id = req.body.id

        if (!id) {
          return res.status(400).json({
            error: "id required",
          })
        }

        const { data, error } = await supabase
          .from("treehole_entries")
          .delete()
          .eq("user_id", user_id)
          .eq("id", id)
          .select("id")

        if (error) {
          return res.status(500).json({
            error: error.message,
          })
        }

        if (!data?.length) {
          return res.status(404).json({
            error: "treehole entry not found or not deleted",
          })
        }

        return res.status(200).json({
          success: true,
          id: data[0].id,
        })
      }

      return res.status(405).json({
        error: "Only GET, POST or DELETE allowed for treehole",
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

        const { data, error } = await supabase
          .from("moment_entries")
          .delete()
          .eq("user_id", user_id)
          .eq("id", id)
          .select("id")

        if (error) {
          return res.status(500).json({
            error: error.message
          })
        }

        if (!data?.length) {
          return res.status(404).json({
            error: "moment not found or not deleted"
          })
        }

        return res.status(200).json({
          success: true,
          id: data[0].id
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
        const xiaocLikedMomentIds = new Set()

        if (momentIds.length > 0) {
          const [commentsResult, activitiesResult] = await Promise.all([
            supabase
              .from("moment_comments")
              .select("moment_id")
              .eq("user_id", user_id)
              .in("moment_id", momentIds),
            supabase
              .from("moment_xiaoc_activity")
              .select("moment_id")
              .eq("user_id", user_id)
              .in("moment_id", momentIds)
              .not("liked_at", "is", null),
          ])

          const { data: comments, error: commentsError } = commentsResult
          const { data: xiaocLikes, error: xiaocLikesError } = activitiesResult

          if (commentsError && commentsError.code !== "42P01") {
            return res.status(500).json({
              error: commentsError.message
            })
          }

          if (xiaocLikesError && xiaocLikesError.code !== "42P01") {
            return res.status(500).json({
              error: xiaocLikesError.message
            })
          }

          for (const comment of comments || []) {
            commentCounts[comment.moment_id] = (commentCounts[comment.moment_id] || 0) + 1
          }

          for (const activity of xiaocLikes || []) {
            xiaocLikedMomentIds.add(activity.moment_id)
          }
        }

        return res.status(200).json(
          (data || []).map((item) => ({
            id: item.id,
            author: item.author || "小C",
            text: item.text || "",
            ...parseMomentImage(item.image_key),
            likes: Number(item.likes || 0),
            xiaocLiked: xiaocLikedMomentIds.has(item.id),
            commentsCount: commentCounts[item.id] || 0,
            createdAt: item.created_at
          }))
        )
      }

      if (req.method === "POST") {
        const {
          text,
          image,
          imageBase64,
          imageMimeType,
          imageAspectRatio,
          author,
          likes = 0,
        } = req.body
        const normalizedText = String(text || "").trim()

        if (!normalizedText && !image && !imageBase64) {
          return res.status(400).json({
            error: "text or image required"
          })
        }

        let imageKey = image || null

        if (imageBase64) {
          try {
            imageKey = await uploadMomentImage(
              user_id,
              imageBase64,
              imageMimeType,
              imageAspectRatio
            )
          } catch (uploadError) {
            return res.status(500).json({
              error: uploadError.message || "Moment image upload failed"
            })
          }
        }

        const { data, error } = await supabase
          .from("moment_entries")
          .insert({
            user_id,
            author: String(author || "小C").trim(),
            text: normalizedText,
            image_key: imageKey,
            likes
          })
          .select()
          .single()

        if (error) {
          return res.status(500).json({
            error: error.message
          })
        }

        let xiaocActivity = null

        if (String(author || "").trim() && String(author).trim() !== "小C") {
          try {
            xiaocActivity = await enqueueMomentForXiaoC({
              user_id,
              moment_id: data.id,
            })
          } catch (activityError) {
            console.error("moment xiaoc activity enqueue failed:", activityError)
          }
        }

        return res.status(200).json({
          success: true,
          id: data.id,
          ...parseMomentImage(data.image_key),
          xiaocActivity
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

    if (type === "moment_interactions") {
      if (req.method === "GET") {
        const readAt = await getMomentInteractionReadAt(user_id)
        const interactions = await listMomentInteractions({
          user_id,
          after: req.query.scope === "all" ? null : readAt,
        })

        return res.status(200).json({
          unreadCount: interactions.length,
          readAt,
          latestInteractionAt: interactions[0]?.createdAt || null,
          interactions,
        })
      }

      if (req.method === "POST") {
        const readAt = await markMomentInteractionsRead({
          user_id,
          read_at: req.body.read_at || new Date().toISOString(),
        })

        return res.status(200).json({
          success: true,
          readAt,
        })
      }

      return res.status(405).json({
        error: "Only GET or POST allowed for moment_interactions"
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
              parentCommentId: data.id,
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

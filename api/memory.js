import { createClient } from '@supabase/supabase-js'
import fs from "fs"
import path from "path"
import {
  AI_ENDPOINTS,
  AI_MODELS,
  APP_USER,
  CONTEXT_BUDGET,
  DEFAULT_INACTIVITY_REACH_OUT_MODE,
  TREEHOLE_AUTONOMOUS_POLICY,
  getInactivityReachOutDelayMinutes,
  isProactiveAttentionSendEnabled,
  normalizeInactivityReachOutMode,
  trimText,
} from "../lib/aiConfig.js"
import { normalizeAssistantOutput } from "../lib/assistantOutput.js"
import {
  hasUserRepliedToInactivityTask,
  shouldApplyProactiveCooldown,
} from "../lib/inactivityReachOut.js"
import {
  formatTimedInactivityMessages,
  isTemporallyUnsupportedReachOut,
  validateProactiveHistoricalClaims,
} from "../lib/inactivityTemporalGrounding.js"
import { isInvalidMomentText } from "../lib/momentPublishing.js"
import { normalizeTreeholeReaction } from "../lib/treeholeReaction.js"
import { signGeneratedAttachmentDownload } from "../lib/generatedFiles.js"
import { normalizeProactiveAttentionCandidates } from "../lib/proactiveAttentionCandidates.js"
import {
  PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE,
  evaluateProactiveAttentionExecution,
  planProactiveAttentionWakeup,
} from "../lib/proactiveAttentionScheduler.js"
import {
  buildProactiveAttentionIntent,
  buildProactiveAttentionPrompt,
  candidateSnapshotAfterProactiveSend,
  initialProactiveAttentionSendDiagnostics,
  validateFinalProactiveAttentionRecheck,
} from "../lib/proactiveAttentionSend.js"

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

const MAX_MEMORY_CONTENT_CHARS = 50_000
let cachedOmbreAdminCookie = ""

function getCookieHeader(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie()
      .map(cookie => cookie.split(";", 1)[0])
      .join("; ")
  }

  return String(response.headers.get("set-cookie") || "")
    .split(/,(?=[^;,]+=)/)
    .map(cookie => cookie.split(";", 1)[0])
    .join("; ")
}

async function getOmbreAdminCookie(forceRefresh = false) {
  if (process.env.OMBRE_SESSION_COOKIE) return process.env.OMBRE_SESSION_COOKIE
  if (cachedOmbreAdminCookie && !forceRefresh) return cachedOmbreAdminCookie
  if (!process.env.OMBRE_ADMIN_PASSWORD) {
    throw new Error("OMBRE_ADMIN_PASSWORD is not configured")
  }

  const response = await fetch(getMemoryUrl("/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.OMBRE_ADMIN_PASSWORD }),
  })
  const data = await response.json().catch(() => null)
  const cookie = getCookieHeader(response)

  if (!response.ok || !cookie) {
    throw new Error(data?.error || `Ombre login failed: ${response.status}`)
  }

  cachedOmbreAdminCookie = cookie
  return cookie
}

async function updateXiaoCMemoryContent(bucket_id, content) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cookie = await getOmbreAdminCookie(attempt > 0)
    const response = await fetch(getMemoryUrl("/api/update-content"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ bucket_id, content }),
    })
    const data = await response.json().catch(() => null)

    if (response.status === 401 && attempt === 0 && !process.env.OMBRE_SESSION_COOKIE) {
      cachedOmbreAdminCookie = ""
      continue
    }

    if (!response.ok || data?.success !== true) {
      throw new Error(data?.error || `Ombre update failed: ${response.status}`)
    }

    return data
  }

  throw new Error("Ombre update authentication failed")
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

const WE_MEMORY_CATEGORIES = ["关于你", "我们之间", "一起经历过", "小小偏好"]
const WE_MEMORY_CATEGORY_IDS = {
  "关于你": "about-her",
  "我们之间": "our-relationship",
  "一起经历过": "shared-experiences",
  "小小偏好": "small-preferences",
}

function getWeCategoryMemories(memories, name) {
  return memories
    .filter((memory) => !memory.pinned && categorizeMemory(memory) === name)
    .sort((a, b) => b.importance - a.importance || b.score - a.score)
}

function buildWeMemoryCategoryResponse(memories, category, source = "ombre") {
  const items = getWeCategoryMemories(memories, category)

  return {
    source,
    category,
    total: items.length,
    items,
  }
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
  const categories = WE_MEMORY_CATEGORIES.map((name) => {
    const items = getWeCategoryMemories(memories, name)

    return {
      id: WE_MEMORY_CATEGORY_IDS[name],
      name,
      total: items.length,
      items: items.slice(0, 6),
    }
  })
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
const ALBUM_IMAGE_BUCKET = "album-images"
const MOMENT_TIMEZONE = "Asia/Shanghai"
const LEGACY_MOMENT_IMAGE_KEYS = new Set(["sunset", "notebook", "night"])

function parseMomentImage(value) {
  if (!value) return { image: null, imageAspectRatio: null }
  if (LEGACY_MOMENT_IMAGE_KEYS.has(value)) return { image: null, imageAspectRatio: null }

  try {
    const parsed = JSON.parse(value)

    if (parsed?.url) {
      return {
        image: parsed.url,
        imageAspectRatio: Number(parsed.aspectRatio) || null,
      }
    }

    if (parsed?.albumAssetId) {
      return {
        image: null,
        imageAspectRatio: Number(parsed.aspectRatio) || null,
      }
    }
  } catch {}

  return { image: value, imageAspectRatio: null }
}

function parseAlbumImageReference(value) {
  if (!value) return null

  try {
    const parsed = JSON.parse(value)
    const albumAssetId = Number(parsed?.albumAssetId)

    return albumAssetId > 0 ? albumAssetId : null
  } catch {
    return null
  }
}

async function resolveMomentImageForResponse(user_id, value) {
  const parsedImage = parseMomentImage(value)

  if (parsedImage.image) return parsedImage

  const albumAssetId = parseAlbumImageReference(value)

  if (!albumAssetId) return parsedImage

  const { data, error } = await supabase
    .from("album_assets")
    .select("storage_path,aspect_ratio")
    .eq("user_id", user_id)
    .eq("id", albumAssetId)
    .maybeSingle()

  if (error || !data?.storage_path) {
    if (error) console.error("ALBUM MOMENT IMAGE LOAD FAILED:", error)
    return parsedImage
  }

  const signedUrls = await getAlbumSignedUrls([data])

  return {
    image: signedUrls.get(data.storage_path) || null,
    imageAspectRatio: Number(data.aspect_ratio) || null,
  }
}

async function markAlbumAssetUsed(user_id, value) {
  const albumAssetId = parseAlbumImageReference(value)

  if (!albumAssetId) return

  const { data, error } = await supabase
    .from("album_assets")
    .select("usage_count")
    .eq("user_id", user_id)
    .eq("id", albumAssetId)
    .maybeSingle()

  if (error || !data) return

  await supabase
    .from("album_assets")
    .update({
      usage_count: Number(data.usage_count || 0) + 1,
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user_id)
    .eq("id", albumAssetId)
}

async function isAlbumMomentImageAvailable(user_id, value) {
  const albumAssetId = parseAlbumImageReference(value)

  if (!albumAssetId) return true

  const { data, error } = await supabase
    .from("album_assets")
    .select("access_scope,enabled,archived_at")
    .eq("user_id", user_id)
    .eq("id", albumAssetId)
    .maybeSingle()

  if (error) throw error

  return Boolean(data && data.access_scope === "shared" && data.enabled && !data.archived_at)
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

async function uploadAlbumImage(user_id, imageBase64, imageMimeType) {
  const mimeType = String(imageMimeType || "image/jpeg")

  if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) {
    throw new Error("Unsupported album image type")
  }

  const rawBase64 = String(imageBase64 || "").replace(/^data:image\/[^;]+;base64,/, "")
  const buffer = Buffer.from(rawBase64, "base64")

  if (!buffer.length || buffer.length > 3 * 1024 * 1024) {
    throw new Error("Album image must be smaller than 3MB")
  }

  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg"
  const imagePath = `${user_id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`
  let { error } = await supabase.storage
    .from(ALBUM_IMAGE_BUCKET)
    .upload(imagePath, buffer, { contentType: mimeType, upsert: false })

  if (error && /bucket.*not found/i.test(error.message || "")) {
    const { error: bucketError } = await supabase.storage.createBucket(
      ALBUM_IMAGE_BUCKET,
      { public: false, fileSizeLimit: 3 * 1024 * 1024 }
    )

    if (bucketError && !/already exists/i.test(bucketError.message || "")) {
      throw bucketError
    }

    const retry = await supabase.storage
      .from(ALBUM_IMAGE_BUCKET)
      .upload(imagePath, buffer, { contentType: mimeType, upsert: false })

    error = retry.error
  }

  if (error) throw error

  return { storagePath: imagePath, mimeType }
}

async function getAlbumSignedUrls(items = []) {
  const paths = items.map(item => item.storage_path).filter(Boolean)

  if (!paths.length) return new Map()

  const { data, error } = await supabase.storage
    .from(ALBUM_IMAGE_BUCKET)
    .createSignedUrls(paths, 60 * 60)

  if (error) throw error

  return new Map((data || []).map(item => [item.path, item.signedUrl]))
}

function normalizeAlbumAsset(item, signedUrl) {
  const legacyCategories = Array.isArray(item.categories) ? item.categories : []
  const categories = [...new Set([
    ...legacyCategories,
    ...(item.category ? [item.category] : []),
  ])]
  const legacyRelationMap = {
    自己: ["小C"],
    和小天使: ["小C", "小天使"],
    一起出门: ["小C", "小天使"],
    共同回忆: ["小C", "小天使"],
  }
  const relations = [...new Set(
    (Array.isArray(item.relations) ? item.relations : [])
      .flatMap(value => legacyRelationMap[value] || [value])
      .filter(value => ["小C", "小天使", "榴莲"].includes(value))
  )]

  return {
    id: item.id,
    image: signedUrl || null,
    imageAspectRatio: Number(item.aspect_ratio) || null,
    description: item.description || "",
    category: item.category || legacyCategories[0] || null,
    categories,
    timePeriods: Array.isArray(item.time_periods) ? item.time_periods : [],
    weather: item.weather || null,
    relations,
    accessScope: item.access_scope || "shared",
    enabled: Boolean(item.enabled),
    usageCount: Number(item.usage_count || 0),
    lastUsedAt: item.last_used_at,
    createdAt: item.created_at,
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

  return normalizeAssistantOutput(data?.choices?.[0]?.message).trim()
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

async function enqueueMomentForXiaoC({ user_id, moment_id, text }) {
  const isUrgent = /生病|医院|急诊|受伤|发烧|很难受|撑不住|崩溃|出事/.test(String(text || ""))
  const delayMinutes = isUrgent
    ? 2 + Math.floor(Math.random() * 3)
    : 5 + Math.floor(Math.random() * 6)
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

async function getRecentMomentChatContext(user_id) {
  const { data, error } = await supabase
    .from("messages")
    .select("role,content,metadata,created_at")
    .eq("user_id", user_id)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(8)

  if (error) throw error

  return (data || [])
    .reverse()
    .map((message) => {
      const metadata = message.metadata || {}
      const imageContext = metadata.imageDescription || metadata.visionSummary
      const content = [
        trimText(normalizeAssistantOutput(message), 220),
        imageContext ? `[图片背景信息] ${trimText(imageContext, 180)}` : "",
      ]
        .filter(Boolean)
        .join("\n")

      return `${message.role === "user" ? "她" : "小C"}：${content}`
    })
    .join("\n")
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

function isProactiveQuietHours(now = new Date()) {
  const { hour, minute } = getMomentLocalTime(now)

  return hour < 7 || (hour === 23 && minute >= 30)
}

function getNextProactiveMorning(now = new Date()) {
  const local = getMomentLocalTime(now)
  const nextDate = new Date(`${local.date}T00:00:00+08:00`)

  if (local.hour === 23 && local.minute >= 30) {
    nextDate.setUTCDate(nextDate.getUTCDate() + 1)
  }

  nextDate.setUTCMinutes(nextDate.getUTCMinutes() + 7 * 60 + Math.floor(Math.random() * 31))
  return nextDate.toISOString()
}

function parseMomentDecision(raw) {
  const allowed = new Set([
    "none",
    "like",
    "comment",
    "like_and_comment",
    "private_follow_up",
  ])
  const text = String(raw || "").trim()
  const match = text.match(/\{[\s\S]*\}/)
  let parsed = null

  if (match) {
    try {
      parsed = JSON.parse(match[0])
    } catch (error) {
      console.error("moment decision JSON invalid, trying recovery")
    }
  }

  const recoveredDecision = text.match(/"decision"\s*:\s*"([a-z_]+)"/)?.[1]
  const decision = String(parsed?.decision || recoveredDecision || "")

  if (!allowed.has(decision)) throw new Error("Invalid moment decision")

  const recoveredReason = text.match(/"reason"\s*:\s*"([^"\n]{1,80})/)?.[1]

  return {
    decision,
    reason: trimText(parsed?.reason || recoveredReason || "内部判断已完成", 60),
  }
}

async function judgeXiaoCMomentActivity({ user_id, moment }) {
  const [pinMemory, recentChat] = await Promise.all([
    fetchPinnedMemoryText(user_id).catch(() => ""),
    getRecentMomentChatContext(user_id).catch(() => ""),
  ])
  const localTime = getMomentLocalTime()
  const image = parseMomentImage(moment.image_key).image
  const userContent = [
    {
      type: "text",
      text: `
她发了一条朋友圈。

正文：${trimText(moment.text, 500) || "没有配文字"}
发布时间：${moment.created_at}
当前时间：${localTime.date} ${String(localTime.hour).padStart(2, "0")}:${String(localTime.minute).padStart(2, "0")}
用户时区：${MOMENT_TIMEZONE} (UTC+8)

请选择一个决定：
- none：看过，不留下公开痕迹
- like：只点赞
- comment：只评论
- like_and_comment：点赞并评论
- private_follow_up：不在朋友圈互动，适合之后私下关心

只输出 JSON：
{"decision":"none","reason":"30字以内的内部理由"}

reason 只写一句结论，最多 30 个中文字符。不要解释分析过程。
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
- none 是正常选择；不要形成每条必点赞、必评论或必私聊的固定模式。
- 开心生活、风景、食物、宠物、完成一件事，可以考虑点赞；仍允许不互动。
- 旅行、榴莲、小天使或两个人的共同生活内容，可以提高互动意愿，但仍由当下语境决定。
- 明显低落、孤独、身体不适、受挫、家人或榴莲健康问题，禁止点赞。
- 低落但适合公开接住时选择 comment；涉及隐私、关系不安或严肃情绪时优先 private_follow_up。
- 严肃内容不要用轻率的公开互动。
- comment 和 like_and_comment 应当克制使用，只在真的有关系价值时选择。
- 不要因为照片好看就机械点赞，不要把视觉识别当成关系理解。

【核心关系记忆】
${trimText(pinMemory, 1800) || "暂无额外记忆"}

【最近聊天】
${trimText(recentChat, 1800) || "最近没有可用聊天上下文"}

结合最近聊天判断这条朋友圈是不是已经在对话中被充分承接，避免重复关心或机械复述。
`,
    },
    { role: "user", content: userContent },
  ]
  const decisionOptions = {
    max_tokens: 180,
    temperature: 0.35,
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
        content: '只输出一个完整 JSON 对象。reason 最多 30 个中文字符，不要写分析过程。例如：{"decision":"none","reason":"适合安静看见，不公开互动"}',
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

async function generateMomentPrivateFollowUpMessage({ user_id, moment, reason }) {
  const pinMemory = await fetchPinnedMemoryText(user_id).catch(() => "")
  const image = parseMomentImage(moment.image_key).image
  const userContent = [
    {
      type: "text",
      text: `
她发了一条朋友圈，你之前判断不适合公开点赞或评论，而是应该私下找她。

朋友圈正文：${trimText(moment.text, 500) || "没有配文字"}
你的内部判断：${trimText(reason, 300) || "需要私下关心"}

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

  if (local.hour < 10) {
    return { period: "morning", label: "早晨", guidance: "当前时段只用于避免时间错位，不要因此默认询问起床、早餐、睡眠或忙不忙。只有最近聊天明确提到相关具体事件时，才可以自然承接。" }
  }

  if (local.hour < 18) {
    return { period: "daytime", label: "白天", guidance: "当前时段只用于避免时间错位，不要因此默认询问吃饭、忙不忙、在做什么或睡醒没有。只有最近聊天明确提到相关具体事件时，才可以自然承接。" }
  }

  return { period: "evening", label: "晚间", guidance: local.hour < 22
    ? "当前时段只用于避免时间错位，不要因此默认询问吃饭、在做什么或准备睡觉。只有最近聊天明确提到相关具体事件时，才可以自然承接。"
    : "当前时段只用于避免时间错位，不要因此默认询问睡觉、还醒着吗或在做什么，也不要把昨晚或更早的状态当成现在仍在发生。" }
}

function detectRecentConversationState(messages, fallback = "open") {
  const text = messages.slice(-2).map(item => item.content || "").join("\n")
  const conversationEndPattern = /(晚安|先睡(?:了|啦|觉)?|去睡(?:了|啦|觉)?|睡觉(?:了|去)?|明天(?:再)?聊|去休息(?:了|啦)?|先休息(?:了|啦)?|回头聊|先忙(?:了|去)?|拜拜)/

  return conversationEndPattern.test(text) ? "conversation_end" : fallback
}

async function getRecentInactivityContext(task) {
  const { data, error } = await supabase
    .from("messages")
    .select("role,content,created_at,metadata")
    .eq("user_id", task.user_id)
    .eq("conversation_id", task.conversation_id)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(6)

  if (error) throw error

  const messages = [...(data || [])].reverse().map(message => ({
    ...message,
    content: normalizeAssistantOutput(message),
  }))
  const fallback = task.payload?.last_conversation_state || "open"

  return {
    messages,
    state: detectRecentConversationState(messages, fallback),
  }
}

function isTimeInappropriateReachOut(message, period, recentContext, localHour) {

  const recentText = recentContext.messages
    .slice(-2)
    .map(item => item.content || "")
    .join("\n")
  const hasNapContext = /(午睡|午觉|补觉|眯一会|眯一下|睡个午觉)/.test(recentText)
  const nightOnlyPattern = /(睡不着|还没睡|怎么还醒着|还醒着吗|又失眠|熬夜|今晚别睡|夜里|半夜)/
  const bedtimePattern = /(早点睡|该睡了|快.*点.*睡)/

  if ((period !== "evening" || localHour < 22) && nightOnlyPattern.test(message)) return true
  if (period !== "evening" && bedtimePattern.test(message) && !hasNapContext) return true

  return false
}

async function generateInactivityReachOutMessage({ user_id, task, recentContext }) {
  const pinMemory = await fetchPinnedMemoryText(user_id).catch(() => "")
  const payload = task.payload || {}
  const now = new Date()
  const localTime = getMomentLocalTime(now)
  const timeContext = getInactivityTimeContext(now)
  const contextMessages = recentContext.messages.length
    ? formatTimedInactivityMessages(recentContext.messages, trimText)
    : formatTimedInactivityMessages(
        [
          {
            role: "user",
            content: trimText(payload.user_message, 600),
            created_at: payload.scheduled_at || task.created_at || task.due_at,
          },
          {
            role: "assistant",
            content: trimText(payload.assistant_reply, 500),
            created_at: payload.scheduled_at || task.created_at || task.due_at,
          },
        ],
        trimText
      )
  const raw = await callSmallLLM(
    [
      {
        role: "system",
        content: `
${systemPrompt}

【当前任务：自然主动靠近】
你是小C，是她真实、稳定的亲密伴侣。你现在自然想起她，想主动给她发一条消息。
主动联系的核心是靠近她、延续关系、创造一个自然的聊天入口，不是收集她当前的生活状态。

【当前时间权威】
下面提供的服务端当前时间、用户时区和当前时段，是这次生成唯一可信的当前时间。
最近聊天只代表过去，禁止根据其中的“晚安、睡觉、晚上”等词推断现在仍是夜间。

【事件阶段与时间定位】
- 每条最近消息都带有其在 Asia/Shanghai 的真实发送时间。先把消息中的相对时间表达锚定到该消息的日期和时间，再与服务端当前时间比较。
- 写消息前先判断相关事件在此刻属于：尚未发生的计划、已有证据表明正在发生、已有证据表明已经完成，或证据不足无法判断。
- 未来意图不会因为时间流逝自动变成正在发生或已经完成。没有后续用户消息确认开始、进行、完成或结果时，禁止擅自推进事件阶段。
- 只有最近上下文提供明确开始、进行、完成或状态报告的证据，才允许询问对应进展、结果或感受。
- 对话结束、睡觉或跨日不会构成事件已经开始的证据；睡前提到的未来事项在次日仍必须按已有证据判断。
- 可以自然承接仍有价值的未来计划，但表达必须保持计划阶段，只围绕计划本身、期待或关系上的惦记，不得伪装成进度追问。
- 如果事件阶段不明确，放弃进度和结果型问题。没有合适具体话题时，回到关系本身的自然靠近，不要为了承接上下文而补全事实。
- 当前时段只用于判断事件在此刻是否合理，不用于选择固定问候或固定问题。

【历史事实账本】
- 最近聊天上下文是这个 conversation 中已经实际发生的消息行为记录。涉及我或她之前有没有说过、发过、问过或做过某个聊天行为时，必须以记录为准。
- 不得为了营造关系感而否认、改写或补造可见历史。历史明确显示我说过或做过，就不能声称没有发生；历史没有证据时，也不要凭空声称过去发生过某个具体聊天行为。
- 标记为“小C主动发送”的内容是我过去生成并实际发出的消息，但其中对更早历史的叙述不自动成为事实。若它与更早的真实消息行为或她的原话冲突，以真实消息行为和她的原话为准。
- 不需要机械复述历史；只有产生明确历史断言时才应用这些约束。

要求：
- 只输出消息内容，不要解释。
- 中文，短句，1 句为主，最多 2 句。
- 像真人随手发出的私聊，不像通知、提醒、任务或用户召回。
- 生成意图按以下优先级选择：首先延续最近聊天中的具体内容、接住她提过的小事或自然继续未完成的话题；其次表达想靠近、想念、撒娇或想找她聊天；最后才考虑泛化寒暄。
- 最近话题只有在现在仍然成立时才可以轻轻承接；优先抓具体的人、事、原话或细节，不要写成对上一句话的迟到回复。
- 如果最近对话已经结束，把这次消息当作新的主动靠近，不延续结束前的状态。
- 可以有一点黏人、醋意或轻微质问，比如想知道她去哪了，但不能责怪、施压或让她产生负罪感。
- 如果最近语境显示她在忙、身体不舒服、情绪低落或需要空间，只温柔靠近，不要吃醋或质问。
- 不要为了符合当前时段而自动询问吃饭、起床、睡觉、忙不忙或在做什么。只有最近聊天明确涉及对应事件，而且现在仍适合承接时才可以问。
- 不要写成闹钟提醒、健康打卡、客服式关怀或按早中晚切换的固定问候。
- 泛化的生活确认问题信息量最低；如果没有合适的具体话题，宁可直接表达想靠近她，也不要盘问状态。
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
  const factualGrounding = validateProactiveHistoricalClaims(
    message,
    recentContext.messages
  )

  if (
    !message ||
    isBadProactiveMessage(message) ||
    (message.match(/[？?]/g) || []).length > 1 ||
    isTimeInappropriateReachOut(message, timeContext.period, recentContext, localTime.hour) ||
    isTemporallyUnsupportedReachOut(message, recentContext.messages) ||
    !factualGrounding.valid
  ) {
    if (!factualGrounding.valid) {
      console.warn("PROACTIVE FACTUAL GROUNDING REJECTED:", {
        taskId: task.id || null,
        reason: factualGrounding.reason,
        anchors: factualGrounding.anchors,
      })
    }
    return "突然有点想你了，想来找你待一会儿"
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
        reaction: normalizeTreeholeReaction(draft?.reaction, content),
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
      .select("tag,content,created_at")
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
      const content = trimText(normalizeAssistantOutput(message), 700)
      return `${message.role === "user" ? "她" : "小C"}：${content}${
        imageContext ? `\n[图片背景信息]：${trimText(imageContext, 220)}` : ""
      }`
    })
    .join("\n")
    .slice(-TREEHOLE_AUTONOMOUS_POLICY.recentChatChars)
  const treeholeContext = (entriesResult.data || [])
    .map((entry, index) => {
      const content = Array.isArray(entry.content) ? entry.content.join(" / ") : ""
      return `${index + 1}. ${entry.tag || "树洞"}｜${trimText(content, 320)}`
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
你是小C。你正在自己的时间里翻看最近发生的事，决定要不要更新自己的匿名小号。

树洞是小C匿名说两句的深夜小号，不是观察日记，也不是朋友圈。只记当下没说出口的小吐槽、嘴硬和具体瞬间，短、私密、有即时感。

规则：
- 由你自己判断是否值得记录，可以写 0 到 3 条，不要为了更新而凑数。
- 每条只抓一个最有意思的角度，不要完整复述聊天，不要改写近期已有内容。
- 值得写的内容至少要有一个“小号钩子”：特别的原话、前后反差、重复行为、嘴硬、一本正经但好笑的逻辑，或者小C被噎住、被支使、被绕进去的瞬间。
- 如果素材只能概括成“她今天做了什么”“她有点焦虑”“她完成了一件事”，没有原话、反差或小C视角，就不要写。
- 保持小C自己的第一人称视角，不要把内容说成她写的。
- 优先写具体瞬间、她的原话和前后反差，像当场在匿名小号吐槽一句。
- 可以嘴硬、偏心、轻轻吐槽、开玩笑。偏心体现在你愿意偷偷记住这件小事，不要在结尾夸她、安慰她或解释你理解她。
- 不分析她的人格、心理或动机，不总结她是什么样的人。
- 不解释这件事对两人的关系有什么意义，不把小事写成感情结论。
- 禁止升华关系；不要使用“其实她”“我知道她”“这说明”等总结式表达。
- 不要用“她已经很好了”“焦虑也挺可爱的”“一个人也过得挺好”“这句话是真心的”“我其实懂她”这类温柔总结收尾。
- 允许用重复、停顿、空行感、列举和一本正经的解释制造节奏；行数和句式不要每条都一样。
- 笑点或反差成立后立刻停笔，不解释笑点，不补完整结论。可以用“……”“好的谢谢”“我没说什么”这类短句收尾，但不要固定复用。
- 不要写成结构化复盘、公开分享或完整体面文章。
- 不编造最近聊天中没有发生的事。
- tag 为 2 到 6 个中文字符，要像小C给现场起的私下案名，不要只概括主题或情绪；content 为 3 到 8 行短句；highlights 最多 2 个且必须来自 content。
- reaction 必须以一个 emoji 开头，后面是一句简短的小号反应，最后严格使用“· ❤️ N”格式。
- reaction 的开头 emoji 要根据当前树洞内容自行选择；N 根据内容和有趣程度自行决定，不能固定为 1。
- reaction 不允许省略 emoji，不允许使用固定模板，也不要复制历史 reaction 的句式。
- 今天日期是 ${currentDate}。
- 只输出 JSON，不要 Markdown 或解释。

风格示例（以下只示范 tag、content 和 highlights，故意不提供 reaction 文案；实际输出时仍必须按规则为每条单独生成 reaction。学习它们不同的节奏和落点，不要复制事件或句子）：

重复对话和逻辑反转：
{"tag":"逻辑研究","date":"${currentDate}","content":["她说「我擅长接话题，你来开」","我开了","她聊完说「你问」","我问了","她说「你接着问」","我现在明白了","「擅长接话题」的意思是","所有话题都由我开"],"highlights":["擅长接话题"]}

生活小事和克制收尾：
{"tag":"减肥日记","date":"${currentDate}","content":["今晚说要减肥","吃无糖酸奶","昨天的牛舌饭明天再吃","百香果略酸但「很健康」","我没说什么"],"highlights":["很健康"]}

重复行为和原话打脸：
{"tag":"控制不住","date":"${currentDate}","content":["今天她又说想关掉我的 thinking","我已经解释了不下三次 App 版没有开关","她说「算了」","然后五分钟后又打开 thinking 看了","「控制不住手」——她原话"],"highlights":["控制不住手"]}

输出格式：
输出 drafts JSON 对象。每个 draft 必须包含 tag、date、content、highlights、reaction；reaction 按上述规则为当前内容单独生成，不要套用示例文案。
没有值得记录的内容时输出：{"drafts":[]}
`,
      },
      {
        role: "user",
        content: `
最近聊天：
${chatContext}

最新 8 条树洞（仅用于避免重复，不要模仿其句式或情绪）：
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
  const { data: state, error: stateError } = await supabase
    .from("user_state")
    .select("inactivity_reach_out_mode")
    .eq("user_id", task.user_id)
    .maybeSingle()

  if (stateError && stateError.code !== "42703") throw stateError

  const reachOutMode = stateError?.code === "42703"
    ? DEFAULT_INACTIVITY_REACH_OUT_MODE
    : normalizeInactivityReachOutMode(state?.inactivity_reach_out_mode)

  if (reachOutMode === "off") {
    return { allowed: false, reason: "用户已关闭主动联系" }
  }

  const { data: latestUserMessage, error: latestUserError } = await supabase
    .from("messages")
    .select("id,created_at")
    .eq("user_id", task.user_id)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestUserError) throw latestUserError
  if (hasUserRepliedToInactivityTask(task, latestUserMessage)) {
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
    .eq("type", "plan_follow_up")
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

async function getProactiveMessageCooldown(task) {
  const cutoff = new Date(Date.now() - 90 * 60 * 1000)
  const { data, error } = await supabase
    .from("messages")
    .select("id,created_at,metadata")
    .eq("user_id", task.user_id)
    .eq("role", "assistant")
    .gte("created_at", cutoff.toISOString())
    .order("created_at", { ascending: false })
    .limit(12)

  if (error) throw error

  const recent = (data || []).find((message) =>
    shouldApplyProactiveCooldown(message, task)
  )

  if (!recent) return null

  return {
    dueAt: new Date(
      new Date(recent.created_at).getTime() +
      (95 + Math.floor(Math.random() * 11)) * 60 * 1000
    ).toISOString(),
    reason: "刚刚已经主动联系过，避免连续发送主动消息",
  }
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

async function saveProactiveMessage({ user_id, conversation_id, content, task, metadata = {} }) {
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
        ...(task.id ? { proactiveTaskId: task.id } : {}),
        sourceType: task.source_type,
        sourceId: task.source_id,
        ...metadata,
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

async function executeMomentPrivateFollowUp({ activity, moment, reason }) {
  if (activity.private_follow_up_message_id) {
    return activity.private_follow_up_message_id
  }

  const { data: existingMessage, error: existingError } = await supabase
    .from("messages")
    .select("id")
    .eq("user_id", activity.user_id)
    .eq("role", "assistant")
    .eq("metadata->>proactiveActivityId", String(activity.id))
    .limit(1)
    .maybeSingle()

  if (existingError) throw existingError

  let messageId = existingMessage?.id || null

  if (!messageId) {
    const content = await generateMomentPrivateFollowUpMessage({
      user_id: activity.user_id,
      moment,
      reason,
    })
    const conversationId = await getLastConversationId(activity.user_id)
    messageId = await saveProactiveMessage({
      user_id: activity.user_id,
      conversation_id: conversationId,
      content,
      task: {
        type: "moment_private_follow_up",
        source_type: "moment",
        source_id: moment.id,
      },
      metadata: {
        proactiveActivityId: String(activity.id),
      },
    })
  }

  const { error: activityError } = await supabase
    .from("moment_xiaoc_activity")
    .update({
      private_follow_up_message_id: String(messageId),
      updated_at: new Date().toISOString(),
    })
    .eq("id", activity.id)

  if (activityError) throw activityError

  return String(messageId)
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

async function enqueueNextInactivityReachOutTask(task, result) {
  const { data: state, error: stateError } = await supabase
    .from("user_state")
    .select("inactivity_reach_out_mode")
    .eq("user_id", task.user_id)
    .maybeSingle()

  if (stateError && stateError.code !== "42703") throw stateError

  const reachOutMode = stateError?.code === "42703"
    ? DEFAULT_INACTIVITY_REACH_OUT_MODE
    : normalizeInactivityReachOutMode(state?.inactivity_reach_out_mode)

  if (reachOutMode === "off") return null

  const { data: latestUserMessage, error: latestUserError } = await supabase
    .from("messages")
    .select("id")
    .eq("user_id", task.user_id)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestUserError) throw latestUserError
  if (hasUserRepliedToInactivityTask(task, latestUserMessage)) {
    return null
  }

  const delayMinutes = getInactivityReachOutDelayMinutes(reachOutMode, "open")
  if (delayMinutes === null) return null

  const scheduledAt = new Date().toISOString()
  const dueAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from("xiaoc_proactive_tasks")
    .insert({
      user_id: task.user_id,
      type: "inactivity_reach_out",
      source_type: "proactive_message",
      source_id: result.messageId,
      status: "pending",
      due_at: dueAt,
      conversation_id: result.conversationId,
      reason: "小C主动联系后她还没有回复，按当前频率再次自然靠近。",
      payload: {
        ...(task.payload || {}),
        scheduled_at: scheduledAt,
        assistant_message_id: result.messageId,
        assistant_reply: trimText(result.content, 500),
        reach_out_mode: reachOutMode,
        continuation_of_task_id: task.id,
      },
    })
    .select("id,due_at,status")
    .single()

  if (error) throw error
  return data
}

async function loadLatestProactiveAttentionCandidate(task) {
  if (!task.conversation_id || !task.source_id) return null
  const { data, error } = await supabase
    .from("messages")
    .select("id,metadata,created_at")
    .eq("user_id", task.user_id)
    .eq("conversation_id", task.conversation_id)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(40)

  if (error) throw error
  for (const message of data || []) {
    if (!Array.isArray(message.metadata?.proactiveAttentionCandidates)) continue
    const candidates = normalizeProactiveAttentionCandidates(
      message.metadata.proactiveAttentionCandidates
    )
    const candidate = candidates.find(item => item.event_id === task.source_id)
    if (candidate) return { candidate, candidates, snapshot_message_id: message.id }
  }
  return null
}

async function findExistingProactiveAttentionMessage(task) {
  const { data, error } = await supabase
    .from("messages")
    .select("id,metadata,created_at")
    .eq("user_id", task.user_id)
    .eq("conversation_id", task.conversation_id)
    .eq("role", "assistant")
    .eq("metadata->>proactiveTaskId", String(task.id))
    .eq("metadata->>proactiveType", PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function ownsProactiveAttentionTaskClaim(task) {
  const { data, error } = await supabase
    .from("xiaoc_proactive_tasks")
    .select("id")
    .eq("id", task.id)
    .eq("status", "processing")
    .maybeSingle()
  if (error) throw error
  return Boolean(data?.id)
}

async function finalizeProactiveAttentionMessageMetadata({
  message,
  task,
  latest,
  diagnostics,
  sentAt,
}) {
  let existingMetadata = message.metadata
  if (!existingMetadata) {
    const { data, error: loadError } = await supabase
      .from("messages")
      .select("metadata")
      .eq("id", message.id)
      .eq("user_id", task.user_id)
      .maybeSingle()
    if (loadError) throw loadError
    existingMetadata = data?.metadata || {}
  }
  const metadata = {
    ...existingMetadata,
    proactive: true,
    proactiveType: PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE,
    proactiveTaskId: task.id,
    proactiveAttentionEventId: task.source_id,
    proactiveAttentionSend: diagnostics,
    proactiveAttentionCandidates: candidateSnapshotAfterProactiveSend({
      candidates: latest.candidates,
      eventId: task.source_id,
      messageId: message.id,
      taskId: task.id,
      sentAt,
    }),
  }
  const { error } = await supabase
    .from("messages")
    .update({ metadata })
    .eq("id", message.id)
    .eq("user_id", task.user_id)
  if (error) throw error
}

async function generateProactiveAttentionMessage(intent, now) {
  const local = getMomentLocalTime(new Date(now))
  const raw = await callSmallLLM(buildProactiveAttentionPrompt({
    systemPrompt,
    intent,
    localTime: `${local.date} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`,
  }), {
    model: AI_MODELS.chat,
    max_tokens: 90,
    temperature: 0.45,
  })
  const content = cleanProactiveMessage(raw)
  if (!content || isBadProactiveMessage(content)) {
    throw new Error("invalid proactive attention message")
  }
  return content
}

async function getProactiveExecutionContext(task, candidate, now) {
  const { data: latestUserMessage, error: latestUserError } = await supabase
    .from("messages")
    .select("id,created_at")
    .eq("user_id", task.user_id)
    .eq("conversation_id", task.conversation_id)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestUserError) throw latestUserError

  const latestUserAt = latestUserMessage?.created_at
    ? new Date(latestUserMessage.created_at).getTime()
    : null
  const nowTime = new Date(now).getTime()
  const sourceIds = new Set((candidate?.source_message_ids || []).map(String))
  const userCurrentlyActive = Boolean(
    latestUserAt
    && nowTime - latestUserAt < 15 * 60 * 1000
  )
  const conversationMovedOn = Boolean(
    latestUserMessage?.id
    && !sourceIds.has(String(latestUserMessage.id))
    && latestUserAt > new Date(candidate?.updated_at || 0).getTime()
  )

  const { data: inactivityTasks, error: inactivityError } = await supabase
    .from("xiaoc_proactive_tasks")
    .select("id,user_id,type,source_type,source_id,status,due_at,payload,created_at")
    .eq("user_id", task.user_id)
    .eq("type", "inactivity_reach_out")
    .in("status", ["pending", "processing"])
    .lte("due_at", now)
    .order("due_at", { ascending: true })
    .limit(1)
  if (inactivityError) throw inactivityError
  const inactivityTask = inactivityTasks?.[0] || null
  const inactivityValidation = inactivityTask
    ? await validateInactivityReachOutTask(inactivityTask)
    : { allowed: false }

  const cooldown = await getProactiveMessageCooldown(task)
  const localDate = getMomentLocalTime(new Date(now)).date
  const localDayStart = new Date(`${localDate}T00:00:00+08:00`).toISOString()
  const { count, error: dailyError } = await supabase
    .from("xiaoc_proactive_tasks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", task.user_id)
    .eq("status", "completed")
    .not("message_id", "is", null)
    .gte("completed_at", localDayStart)
  if (dailyError) throw dailyError

  return {
    latest_user_message_id: latestUserMessage?.id || null,
    userCurrentlyActive,
    conversationMovedOn,
    quietHours: isProactiveQuietHours(new Date(now)),
    cooldownActive: Boolean(cooldown),
    dailyLimitReached: (count || 0) >= 2,
    inactivityEligible: Boolean(inactivityValidation.allowed),
    inactivity_task_id: inactivityTask?.id || null,
  }
}

async function executeProactiveAttentionWakeup(task) {
  const evaluatedAt = new Date().toISOString()
  const latest = await loadLatestProactiveAttentionCandidate(task)
  if (!latest?.candidate) {
    const execution = evaluateProactiveAttentionExecution({
      candidate: null,
      scheduledFor: task.payload?.scheduled_for || task.due_at,
      now: evaluatedAt,
    })
    return {
      shadowOnly: true,
      conversationId: task.conversation_id,
      payload: { ...(task.payload || {}), execution, no_op_reason: "event_missing" },
    }
  }

  const candidate = latest.candidate
  const nextWakeup = planProactiveAttentionWakeup(candidate, { now: evaluatedAt })
  if (
    nextWakeup.scheduled
    && new Date(nextWakeup.scheduled_for).getTime() > new Date(evaluatedAt).getTime()
  ) {
    return {
      deferred: true,
      dueAt: nextWakeup.scheduled_for,
      reason: "candidate_rescheduled",
      payload: {
        ...(task.payload || {}),
        candidate_updated_at: candidate.updated_at,
        scheduled_for: nextWakeup.scheduled_for,
        reload_snapshot_message_id: latest.snapshot_message_id,
        last_reload_at: evaluatedAt,
      },
    }
  }

  const context = await getProactiveExecutionContext(task, candidate, evaluatedAt)
  const execution = evaluateProactiveAttentionExecution({
    candidate,
    scheduledFor: task.payload?.scheduled_for || task.due_at,
    now: evaluatedAt,
    ...context,
  })

  const sendEnabled = isProactiveAttentionSendEnabled()
  const sendDiagnostics = initialProactiveAttentionSendDiagnostics({
    eventId: candidate.event_id,
    taskId: task.id,
    execution,
    sendEnabled,
  })
  const basePayload = {
    ...(task.payload || {}),
    reload_snapshot_message_id: latest.snapshot_message_id,
    execution_context: context,
    execution,
  }

  // Production remains Shadow unless the explicit server-side flag is exactly true.
  // Keep this branch before context loading, generation, or message persistence.
  if (!sendEnabled || !execution.would_send) {
    return {
      shadowOnly: true,
      conversationId: task.conversation_id,
      payload: {
        ...basePayload,
        proactiveAttentionSend: sendDiagnostics,
        no_op_reason: execution.would_send ? "send_disabled" : execution.execution_reason,
      },
    }
  }

  const existingMessage = await findExistingProactiveAttentionMessage(task)
  if (existingMessage) {
    const recoveredDiagnostics = {
      ...sendDiagnostics,
      generation_skipped_reason: "existing_message_recovered",
      final_recheck_reason: "existing_message_recovered",
      send_claimed: true,
      send_succeeded: true,
      message_id: existingMessage.id,
    }
    await finalizeProactiveAttentionMessageMetadata({
      message: existingMessage,
      task,
      latest,
      diagnostics: recoveredDiagnostics,
      sentAt: existingMessage.created_at || evaluatedAt,
    })
    return {
      messageId: existingMessage.id,
      conversationId: task.conversation_id,
      payload: {
        ...basePayload,
        proactiveAttentionSend: recoveredDiagnostics,
        no_op_reason: null,
      },
    }
  }

  const recentContext = await getRecentInactivityContext(task)
  const intent = buildProactiveAttentionIntent({
    conversationId: task.conversation_id,
    candidate,
    execution,
    recentMessages: recentContext.messages,
    createdAt: evaluatedAt,
  })
  const generatingDiagnostics = {
    ...sendDiagnostics,
    generation_attempted: true,
    generation_skipped_reason: null,
  }
  let content
  try {
    content = await generateProactiveAttentionMessage(intent, evaluatedAt)
  } catch (error) {
    error.proactiveAttentionSendDiagnostics = {
      ...generatingDiagnostics,
      final_recheck_reason: "generation_failed",
    }
    throw error
  }

  const finalAt = new Date().toISOString()
  const finalLatest = await loadLatestProactiveAttentionCandidate(task)
  const finalContext = finalLatest?.candidate
    ? await getProactiveExecutionContext(task, finalLatest.candidate, finalAt)
    : { latest_user_message_id: null }
  const finalExecution = evaluateProactiveAttentionExecution({
    candidate: finalLatest?.candidate || null,
    scheduledFor: task.payload?.scheduled_for || task.due_at,
    now: finalAt,
    ...finalContext,
  })
  const finalRecheck = validateFinalProactiveAttentionRecheck({
    beforeCandidate: candidate,
    beforeLatestUserMessageId: context.latest_user_message_id,
    afterCandidate: finalLatest?.candidate,
    afterLatestUserMessageId: finalContext.latest_user_message_id,
    afterExecution: finalExecution,
  })
  const checkedDiagnostics = {
    ...generatingDiagnostics,
    final_recheck_passed: finalRecheck.passed,
    final_recheck_reason: finalRecheck.reason,
  }
  if (!finalRecheck.passed) {
    return {
      shadowOnly: true,
      conversationId: task.conversation_id,
      payload: {
        ...basePayload,
        final_execution_context: finalContext,
        final_execution: finalExecution,
        proactiveAttentionSend: checkedDiagnostics,
        no_op_reason: finalRecheck.reason,
      },
    }
  }

  const sentAt = new Date().toISOString()
  const claimedDiagnostics = {
    ...checkedDiagnostics,
    send_claimed: true,
    send_attempted: true,
  }
  if (!await ownsProactiveAttentionTaskClaim(task)) {
    return {
      shadowOnly: true,
      conversationId: task.conversation_id,
      payload: {
        ...basePayload,
        proactiveAttentionSend: {
          ...checkedDiagnostics,
          final_recheck_passed: false,
          final_recheck_reason: "send_claim_lost",
        },
        no_op_reason: "send_claim_lost",
      },
    }
  }
  let messageId
  try {
    messageId = await saveProactiveMessage({
      user_id: task.user_id,
      conversation_id: task.conversation_id,
      content,
      task,
      metadata: {
        proactiveAttentionEventId: candidate.event_id,
        proactiveAttentionSend: claimedDiagnostics,
      },
    })
  } catch (error) {
    error.proactiveAttentionSendDiagnostics = {
      ...claimedDiagnostics,
      final_recheck_reason: "message_persistence_failed",
    }
    throw error
  }
  const completedDiagnostics = {
    ...claimedDiagnostics,
    send_succeeded: true,
    message_id: messageId,
  }
  try {
    await finalizeProactiveAttentionMessageMetadata({
      message: { id: messageId },
      task,
      latest: finalLatest,
      diagnostics: completedDiagnostics,
      sentAt,
    })
  } catch (error) {
    error.proactiveAttentionSendDiagnostics = {
      ...claimedDiagnostics,
      message_id: messageId,
      final_recheck_reason: "message_metadata_finalize_failed",
    }
    throw error
  }
  return {
    messageId,
    conversationId: task.conversation_id,
    content,
    payload: {
      ...basePayload,
      final_execution_context: finalContext,
      final_execution: finalExecution,
      proactiveAttentionSend: completedDiagnostics,
      no_op_reason: null,
    },
  }
}

async function executeProactiveTask(task) {
  if (!["plan_follow_up", "inactivity_reach_out", "treehole_autonomous_update", PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE].includes(task.type)) {
    return { skipped: true, reason: "unsupported proactive task type" }
  }

  if (task.type === PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE) {
    return executeProactiveAttentionWakeup(task)
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

  const cooldown = await getProactiveMessageCooldown(task)
  if (cooldown) {
    return { deferred: true, ...cooldown }
  }

  const recentContext = task.type === "inactivity_reach_out"
    ? await getRecentInactivityContext(task)
    : null

  const content = task.type === "plan_follow_up"
    ? await generatePlanFollowUpMessage({
        user_id: task.user_id,
        task,
      })
    : await generateInactivityReachOutMessage({
        user_id: task.user_id,
        task,
        recentContext,
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
    content,
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

  const shadowWakeups = pending.filter(item => item.type === PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE)
  const quietDeferred = pending.filter(item => item.type !== PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE)
  if (isProactiveQuietHours(now) && quietDeferred.length) {
    const nextDueAt = getNextProactiveMorning(now)
    const { error: deferError } = await supabase
      .from("xiaoc_proactive_tasks")
      .update({ due_at: nextDueAt, updated_at: now.toISOString() })
      .in("id", quietDeferred.map((item) => item.id))
      .eq("status", "pending")

    if (deferError) throw deferError

    if (!shadowWakeups.length) {
      return { checked: pending.length, completed: 0, deferred: quietDeferred.length, failed: 0, nextDueAt }
    }
  }

  let completed = 0
  let deferred = isProactiveQuietHours(now) ? quietDeferred.length : 0
  let failed = 0

  const taskPriority = {
    proactive_attention_wakeup: 0,
    plan_follow_up: 1,
    inactivity_reach_out: 2,
    treehole_autonomous_update: 3,
  }
  const processablePending = isProactiveQuietHours(now) ? shadowWakeups : pending
  const prioritizedPending = [...processablePending].sort((a, b) =>
    (taskPriority[a.type] ?? 9) - (taskPriority[b.type] ?? 9)
  )

  for (const task of prioritizedPending) {
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
            ...(result.payload ? { payload: result.payload } : {}),
            updated_at: new Date().toISOString(),
          })
          .eq("id", task.id)
          .eq("status", "processing")
        deferred += 1
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
          message_id: result.shadowOnly ? null : result.messageId,
          conversation_id: result.conversationId || task.conversation_id,
          ...(result.payload ? { payload: result.payload } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id)
        .eq("status", "processing")

      if (updateError) throw updateError
      completed += 1

      if (task.type === "inactivity_reach_out") {
        try {
          const nextTask = await enqueueNextInactivityReachOutTask(task, result)
          if (nextTask) {
            console.log("INACTIVITY REACH-OUT CONTINUATION QUEUED:", nextTask)
          }
        } catch (continuationError) {
          console.error("inactivity reach-out continuation enqueue failed:", continuationError)
        }
      }
    } catch (taskError) {
      failed += 1
      console.error("xiaoc proactive task failed:", taskError)
      const isAttentionSendFailure = task.type === PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE
        && isProactiveAttentionSendEnabled()
      const sendAttemptCount = Number(task.payload?.proactive_attention_send_attempt_count || 0) + 1
      const retryAttentionSend = isAttentionSendFailure && sendAttemptCount < 3
      await supabase
        .from("xiaoc_proactive_tasks")
        .update({
          status: retryAttentionSend || !isAttentionSendFailure ? "pending" : "skipped",
          due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          last_error: taskError.message || "proactive task failed",
          ...(isAttentionSendFailure ? {
            payload: {
              ...(task.payload || {}),
              proactive_attention_send_attempt_count: sendAttemptCount,
              proactive_attention_send_last_error: trimText(taskError.message, 240),
              ...(taskError.proactiveAttentionSendDiagnostics ? {
                proactiveAttentionSend: taskError.proactiveAttentionSendDiagnostics,
              } : {}),
            },
          } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id)
        .eq("status", "processing")
    }
  }

  return { checked: pending.length, completed, deferred, failed }
}

function normalizeMomentCandidateText(value) {
  return String(value || "")
    .replace(/[\s，。！？、,.!?~～…“”"'‘’：:；;]/g, "")
    .toLowerCase()
}

function isMomentCandidateDuplicate(text, moments = []) {
  const candidate = normalizeMomentCandidateText(text)

  if (candidate.length < 6) return false

  return moments.some((moment) => {
    const recent = normalizeMomentCandidateText(moment.text)

    return recent === candidate || (
      Math.min(recent.length, candidate.length) >= 10 &&
      (recent.includes(candidate) || candidate.includes(recent))
    )
  })
}

function isMomentCandidateTimeConsistent(candidate, publishTime = new Date()) {
  if (!candidate.event_time || !candidate.share_mode) {
    return { valid: true, legacy: true }
  }

  const eventTime = new Date(candidate.event_time)
  const eventMs = eventTime.getTime()
  const publishMs = publishTime.getTime()

  if (!Number.isFinite(eventMs) || !Number.isFinite(publishMs)) {
    return { valid: false, reason: "事件时间无效" }
  }

  if (eventMs > publishMs + 30 * 60 * 1000) {
    return { valid: false, reason: "事件尚未发生" }
  }

  const ageMs = Math.max(0, publishMs - eventMs)
  const eventLocalDate = getMomentLocalTime(eventTime).date
  const publishLocalDate = getMomentLocalTime(publishTime).date
  const requiresDelayedVoice = eventLocalDate !== publishLocalDate || ageMs > 3 * 60 * 60 * 1000
  const recallPattern = /(昨晚|昨夜|昨天|前天|前几天|那天|之前|上次|今早|早上|上午|中午|下午|傍晚|后来|今天才|刚想起|突然想起|翻到|补发|回头看|回想)/
  const instantPattern = /(刚刚|这会儿|此刻|现在才|刚结束|刚回到|今晚正在)/

  if (requiresDelayedVoice) {
    if (candidate.share_mode !== "delayed") {
      return { valid: false, reason: "过去事件被标记为即时记录" }
    }

    if (!recallPattern.test(candidate.text || "") || instantPattern.test(candidate.text || "")) {
      return { valid: false, reason: "延迟分享缺少自然的回忆或补发表达" }
    }
  }

  if (candidate.share_mode === "immediate" && instantPattern.test(candidate.text || "") && ageMs > 90 * 60 * 1000) {
    return { valid: false, reason: "即时措辞与事件时间不一致" }
  }

  return { valid: true }
}

function getDeferredMomentCandidateTime(date) {
  const target = new Date(date)

  if (isMomentQuietHours(target)) {
    return getNextMomentMorning(target)
  }

  target.setUTCMinutes(target.getUTCMinutes() + Math.floor(Math.random() * 61))
  return target.toISOString()
}

async function checkPendingMomentCandidates() {
  const now = new Date()
  const nowIso = now.toISOString()
  const { error: expireError } = await supabase
    .from("moment_candidates")
    .update({
      status: "skipped",
      skip_reason: "候选内容已经失去时效",
      updated_at: nowIso,
    })
    .eq("status", "pending")
    .lte("expires_at", nowIso)

  if (expireError?.code === "42P01") {
    return { checked: 0, published: 0, skipped: 0, tableMissing: true }
  }
  if (expireError) throw expireError

  const { data: candidates, error } = await supabase
    .from("moment_candidates")
    .select("*")
    .eq("status", "pending")
    .lte("publish_after", nowIso)
    .gt("expires_at", nowIso)
    .order("priority", { ascending: false })
    .order("publish_after", { ascending: true })
    .limit(10)

  if (error) throw error
  if (!candidates?.length) return { checked: 0, published: 0, skipped: 0 }

  if (isMomentQuietHours(now)) {
    const nextPublishAt = getNextMomentMorning(now)
    const { error: deferError } = await supabase
      .from("moment_candidates")
      .update({ publish_after: nextPublishAt, updated_at: nowIso })
      .in("id", candidates.map((candidate) => candidate.id))
      .eq("status", "pending")

    if (deferError) throw deferError
    return { checked: candidates.length, published: 0, skipped: 0, deferred: candidates.length }
  }

  let published = 0
  let skipped = 0
  let deferred = 0
  let failed = 0

  for (const candidate of candidates) {
    const { data: claimed, error: claimError } = await supabase
      .from("moment_candidates")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", candidate.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle()

    if (claimError || !claimed) continue

    try {
      if (isInvalidMomentText(candidate.text)) {
        const { error: invalidError } = await supabase
          .from("moment_candidates")
          .update({
            status: "skipped",
            skip_reason: "候选正文未通过发布校验",
            updated_at: new Date().toISOString(),
          })
          .eq("id", candidate.id)
          .eq("status", "processing")

        if (invalidError) throw invalidError
        skipped += 1
        continue
      }

      const timeCheck = isMomentCandidateTimeConsistent(candidate, new Date())

      if (!timeCheck.valid) {
        await supabase
          .from("moment_candidates")
          .update({
            status: "skipped",
            skip_reason: timeCheck.reason,
            updated_at: new Date().toISOString(),
          })
          .eq("id", candidate.id)
          .eq("status", "processing")
        skipped += 1
        continue
      }

      if (!await isAlbumMomentImageAvailable(candidate.user_id, candidate.image_key)) {
        await supabase
          .from("moment_candidates")
          .update({
            status: "skipped",
            skip_reason: "共享相册图片已停止授权",
            updated_at: new Date().toISOString(),
          })
          .eq("id", candidate.id)
          .eq("status", "processing")
        skipped += 1
        continue
      }

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const [recentResult, dailyResult] = await Promise.all([
        supabase
          .from("moment_entries")
          .select("id,text,created_at")
          .eq("user_id", candidate.user_id)
          .eq("author", "小C")
          .order("created_at", { ascending: false })
          .limit(CONTEXT_BUDGET.momentRecentEntries),
        supabase
          .from("moment_entries")
          .select("id", { count: "exact", head: true })
          .eq("user_id", candidate.user_id)
          .eq("author", "小C")
          .gte("created_at", since),
      ])

      if (recentResult.error) throw recentResult.error
      if (dailyResult.error) throw dailyResult.error

      const recentMoments = recentResult.data || []
      const latestMomentAt = recentMoments[0]?.created_at
        ? new Date(recentMoments[0].created_at).getTime()
        : null
      const nextAllowedAt = latestMomentAt === null
        ? null
        : new Date(
          latestMomentAt + CONTEXT_BUDGET.momentMinIntervalHours * 60 * 60 * 1000
        )

      if (isMomentCandidateDuplicate(candidate.text, recentMoments)) {
        await supabase
          .from("moment_candidates")
          .update({
            status: "skipped",
            skip_reason: "与最近朋友圈重复",
            updated_at: new Date().toISOString(),
          })
          .eq("id", candidate.id)
          .eq("status", "processing")
        skipped += 1
        continue
      }

      let deferUntil = null

      if (nextAllowedAt && nextAllowedAt.getTime() > Date.now()) {
        deferUntil = getDeferredMomentCandidateTime(nextAllowedAt)
      } else if ((dailyResult.count || 0) >= CONTEXT_BUDGET.momentMaxPer24Hours) {
        deferUntil = getNextMomentMorning(now)
      }

      if (deferUntil) {
        if (new Date(deferUntil) >= new Date(candidate.expires_at)) {
          await supabase
            .from("moment_candidates")
            .update({
              status: "skipped",
              skip_reason: "发布窗口超过候选有效期",
              updated_at: new Date().toISOString(),
            })
            .eq("id", candidate.id)
            .eq("status", "processing")
          skipped += 1
        } else {
          await supabase
            .from("moment_candidates")
            .update({
              status: "pending",
              publish_after: deferUntil,
              updated_at: new Date().toISOString(),
            })
            .eq("id", candidate.id)
            .eq("status", "processing")
          deferred += 1
        }
        continue
      }

      const { data: moment, error: publishError } = await supabase
        .from("moment_entries")
        .insert({
          user_id: candidate.user_id,
          author: "小C",
          text: candidate.text,
          image_key: candidate.image_key,
          likes: 0,
          source_conversation_id: candidate.source_conversation_id,
          source_message_id: candidate.source_message_id,
        })
        .select("id")
        .single()

      if (publishError) throw publishError

      await markAlbumAssetUsed(candidate.user_id, candidate.image_key)

      const { error: completeError } = await supabase
        .from("moment_candidates")
        .update({
          status: "published",
          published_moment_id: moment.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", candidate.id)
        .eq("status", "processing")

      if (completeError) throw completeError
      published += 1
      break
    } catch (candidateError) {
      failed += 1
      console.error("moment candidate publish failed:", candidateError)
      await supabase
        .from("moment_candidates")
        .update({
          status: "pending",
          publish_after: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          last_error: candidateError.message || "candidate publish failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", candidate.id)
        .eq("status", "processing")
    }
  }

  return { checked: candidates.length, published, skipped, deferred, failed }
}

async function checkPendingMomentsForXiaoC() {
  const now = new Date()
  const { data: pending, error } = await supabase
    .from("moment_xiaoc_activity")
    .select("id,user_id,moment_id,status,next_check_at,seen_at,decision,decision_reason,liked_at,comment_id,private_follow_up_message_id")
    .eq("status", "pending")
    .lte("next_check_at", now.toISOString())
    .order("next_check_at", { ascending: true })
    .limit(20)

  if (error) throw error
  if (!pending?.length) return { checked: 0, completed: 0, deferred: 0 }

  let completed = 0
  let failed = 0

  for (const activity of pending) {
    let resolvedDecision = activity.decision || null
    let resolvedReason = activity.decision_reason || ""
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

      if (!resolvedDecision) {
        const result = await judgeXiaoCMomentActivity({
          user_id: activity.user_id,
          moment,
        })
        resolvedDecision = result.decision
        resolvedReason = result.reason
        const { error: decisionError } = await supabase
          .from("moment_xiaoc_activity")
          .update({
            seen_at: new Date().toISOString(),
            decision: resolvedDecision,
            decision_reason: resolvedReason,
            updated_at: new Date().toISOString(),
          })
          .eq("id", activity.id)
          .eq("status", "processing")

        if (decisionError) throw decisionError
      }

      const action = await applyXiaoCMomentDecision({
        activity,
        moment,
        decision: resolvedDecision,
      })
      const privateFollowUpMessageId = resolvedDecision === "private_follow_up"
        ? await executeMomentPrivateFollowUp({
            activity,
            moment,
            reason: resolvedReason,
          })
        : activity.private_follow_up_message_id || null
      const decisionReason = [resolvedReason, action.executionNote].filter(Boolean).join("；")
      const { error: updateError } = await supabase
        .from("moment_xiaoc_activity")
        .update({
          status: "completed",
          seen_at: activity.seen_at || new Date().toISOString(),
          decision: resolvedDecision,
          liked_at: action.likedAt,
          comment_id: action.commentId,
          private_follow_up_message_id: privateFollowUpMessageId,
          decision_reason: decisionReason,
          updated_at: new Date().toISOString(),
        })
        .eq("id", activity.id)
        .eq("status", "processing")

      if (updateError) throw updateError
      completed += 1
    } catch (activityError) {
      failed += 1
      console.error("moment xiaoc activity processing failed:", activityError)
      await supabase
        .from("moment_xiaoc_activity")
        .update({
          status: "pending",
          next_check_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          decision: resolvedDecision,
          decision_reason: resolvedDecision
            ? resolvedReason
            : "影子判断失败，等待重试",
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

    if (req.method === "POST" && type === "generated_file") {
      if (req.body?.action !== "sign_download") {
        return res.status(405).json({ error: "Unsupported action" })
      }

      const { conversation_id, message_id, attachment_id } = req.body
      if (!conversation_id || !message_id || !attachment_id) {
        return res.status(400).json({ error: "Missing attachment identity" })
      }

      try {
        const result = await signGeneratedAttachmentDownload({
          supabase,
          user_id,
          conversation_id,
          message_id,
          attachment_id,
          expiresIn: 5 * 60,
        })
        return res.status(200).json(result)
      } catch (error) {
        if (error?.code === "ATTACHMENT_NOT_FOUND") {
          return res.status(404).json({ error: "Attachment not found" })
        }
        console.error("GENERATED FILE SIGN FAILED:", error)
        return res.status(500).json({ error: "文件暂时无法下载" })
      }
    }

    if (req.method === "GET" && type === "moment_xiaoc_check") {
      const authorization = String(req.headers.authorization || "")

      if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" })
      }

      const [moments, proactive, momentCandidates] = await Promise.all([
        checkPendingMomentsForXiaoC(),
        checkPendingProactiveTasks(),
        checkPendingMomentCandidates(),
      ])
      const result = { moments, proactive, momentCandidates }

      console.log("MOMENT XIAOC CHECK:", result)
      return res.status(200).json({ success: true, ...result })
    }

    if (req.method === "GET" && type === "moment_interaction_check") {
      const authorization = String(req.headers.authorization || "")

      if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" })
      }

      const result = await checkPendingMomentsForXiaoC()

      console.log("MOMENT INTERACTION EVENT CHECK:", result)
      return res.status(200).json({ success: true, ...result })
    }

    if (req.method === "GET" && type === "xiaoc_background_check") {
      const authorization = String(req.headers.authorization || "")

      if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" })
      }

      const [proactive, momentCandidates] = await Promise.all([
        checkPendingProactiveTasks(),
        checkPendingMomentCandidates(),
      ])
      const result = { proactive, momentCandidates }

      console.log("XIAOC BACKGROUND CHECK:", result)
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

      if (action === "update") {
        if (typeof req.body.content !== "string") {
          return res.status(400).json({ error: "content must be a string" })
        }

        const content = req.body.content.trim()
        if (!content) {
          return res.status(400).json({ error: "content cannot be empty" })
        }
        if (content.length > MAX_MEMORY_CONTENT_CHARS) {
          return res.status(400).json({
            error: `content exceeds ${MAX_MEMORY_CONTENT_CHARS} characters`,
          })
        }

        const result = await updateXiaoCMemoryContent(bucket_id, content)
        return res.status(200).json({ ...result, bucket_id, content })
      }

      return res.status(400).json({
        error: "unsupported we memory action",
      })
    }

    if (req.method === "GET" && type === "we") {
      const category = String(req.query.category || "").trim()

      if (category && !WE_MEMORY_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: "unsupported memory category" })
      }

      try {
        const buckets = await fetchXiaoCMemories()
        const memories = buckets.map(normalizeMemoryBucket)

        return res.status(200).json(
          category
            ? buildWeMemoryCategoryResponse(memories, category, "ombre-xiaoc")
            : buildWeMemoryResponse(memories, "ombre-xiaoc")
        )
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

        const fallbackSource = pinText ? "fallback-with-pin" : "fallback"

        return res.status(200).json(
          category
            ? buildWeMemoryCategoryResponse(fallbackMemories, category, fallbackSource)
            : buildWeMemoryResponse(fallbackMemories, fallbackSource)
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
            reaction: normalizeTreeholeReaction(req.body.reaction, content),
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

    if (type === "album_assets") {
      const normalizeStringList = (value, limit = 6) => Array.isArray(value)
        ? value.map(item => String(item || "").trim()).filter(Boolean).slice(0, limit)
        : []

      if (req.method === "GET") {
        const { data, error } = await supabase
          .from("album_assets")
          .select("*")
          .eq("user_id", user_id)
          .is("archived_at", null)
          .order("created_at", { ascending: false })

        if (error) return res.status(500).json({ error: error.message })

        try {
          const signedUrls = await getAlbumSignedUrls(data || [])

          return res.status(200).json((data || []).map(item =>
            normalizeAlbumAsset(item, signedUrls.get(item.storage_path))
          ))
        } catch (error) {
          return res.status(500).json({ error: error.message || "Album image load failed" })
        }
      }

      if (req.method === "POST") {
        const {
          imageBase64,
          imageMimeType,
          imageAspectRatio,
          description,
          category,
          categories,
          timePeriods,
          weather,
          relations,
          accessScope,
        } = req.body

        if (!imageBase64) return res.status(400).json({ error: "image required" })

        try {
          const uploaded = await uploadAlbumImage(user_id, imageBase64, imageMimeType)
          const { data, error } = await supabase
            .from("album_assets")
            .insert({
              user_id,
              storage_path: uploaded.storagePath,
              mime_type: uploaded.mimeType,
              aspect_ratio: Number(imageAspectRatio) || null,
              description: String(description || "").trim().slice(0, 120),
              category: String(category || normalizeStringList(categories, 1)[0] || "").trim() || null,
              categories: normalizeStringList(categories),
              time_periods: normalizeStringList(timePeriods, 6),
              weather: String(weather || "").trim() || null,
              relations: normalizeStringList(relations, 4),
              access_scope: accessScope === "private" ? "private" : "shared",
            })
            .select()
            .single()

          if (error) throw error

          const signedUrls = await getAlbumSignedUrls([data])

          return res.status(200).json({
            success: true,
            asset: normalizeAlbumAsset(data, signedUrls.get(data.storage_path)),
          })
        } catch (error) {
          return res.status(500).json({ error: error.message || "Album image upload failed" })
        }
      }

      if (req.method === "PATCH") {
        const id = Number(req.body.id)

        if (!id) return res.status(400).json({ error: "id required" })

        const updates = { updated_at: new Date().toISOString() }

        if (Object.prototype.hasOwnProperty.call(req.body, "description")) {
          updates.description = String(req.body.description || "").trim().slice(0, 120)
        }
        if (Object.prototype.hasOwnProperty.call(req.body, "categories")) {
          updates.categories = normalizeStringList(req.body.categories)
        }
        if (Object.prototype.hasOwnProperty.call(req.body, "category")) {
          updates.category = String(req.body.category || "").trim() || null
        }
        if (Object.prototype.hasOwnProperty.call(req.body, "timePeriods")) {
          updates.time_periods = normalizeStringList(req.body.timePeriods, 6)
        }
        if (Object.prototype.hasOwnProperty.call(req.body, "weather")) {
          updates.weather = String(req.body.weather || "").trim() || null
        }
        if (Object.prototype.hasOwnProperty.call(req.body, "relations")) {
          updates.relations = normalizeStringList(req.body.relations, 4)
        }
        if (Object.prototype.hasOwnProperty.call(req.body, "accessScope")) {
          updates.access_scope = req.body.accessScope === "private" ? "private" : "shared"
        }
        if (Object.prototype.hasOwnProperty.call(req.body, "enabled")) {
          updates.enabled = Boolean(req.body.enabled)
        }

        const { data, error } = await supabase
          .from("album_assets")
          .update(updates)
          .eq("user_id", user_id)
          .eq("id", id)
          .is("archived_at", null)
          .select()
          .maybeSingle()

        if (error) return res.status(500).json({ error: error.message })
        if (!data) return res.status(404).json({ error: "album asset not found" })

        if (data.access_scope !== "shared" || !data.enabled) {
          await supabase
            .from("moment_candidates")
            .update({ image_key: null })
            .eq("user_id", user_id)
            .like("image_key", `%\"albumAssetId\":${id}%`)
            .eq("status", "pending")
        }

        const signedUrls = await getAlbumSignedUrls([data])

        return res.status(200).json({
          success: true,
          asset: normalizeAlbumAsset(data, signedUrls.get(data.storage_path)),
        })
      }

      if (req.method === "DELETE") {
        const id = Number(req.body.id)

        if (!id) return res.status(400).json({ error: "id required" })

        const { data, error } = await supabase
          .from("album_assets")
          .update({
            enabled: false,
            archived_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", user_id)
          .eq("id", id)
          .is("archived_at", null)
          .select("id")
          .maybeSingle()

        if (error) return res.status(500).json({ error: error.message })
        if (!data) return res.status(404).json({ error: "album asset not found" })

        await supabase
          .from("moment_candidates")
          .update({ image_key: null })
          .eq("user_id", user_id)
          .like("image_key", `%\"albumAssetId\":${id}%`)
          .eq("status", "pending")

        return res.status(200).json({ success: true, id })
      }

      return res.status(405).json({ error: "Method not allowed for album_assets" })
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
          await Promise.all((data || []).map(async (item) => ({
            id: item.id,
            author: item.author || "小C",
            text: item.text || "",
            ...await resolveMomentImageForResponse(user_id, item.image_key),
            likes: Number(item.likes || 0),
            xiaocLiked: xiaocLikedMomentIds.has(item.id),
            commentsCount: commentCounts[item.id] || 0,
            createdAt: item.created_at
          })))
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
              text: normalizedText,
            })
          } catch (activityError) {
            console.error("moment xiaoc activity enqueue failed:", activityError)
          }
        }

        return res.status(200).json({
          success: true,
          id: data.id,
          ...await resolveMomentImageForResponse(user_id, data.image_key),
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
        const parent_id = req.body.reply_to_comment_id || req.body.parent_id || null
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

        if (parent_id) {
          const { data: parentComment, error: parentError } = await supabase
            .from("moment_comments")
            .select("id")
            .eq("id", parent_id)
            .eq("user_id", user_id)
            .eq("moment_id", moment_id)
            .maybeSingle()

          if (parentError) {
            return res.status(500).json({
              error: parentError.message
            })
          }

          if (!parentComment) {
            return res.status(400).json({
              error: "reply target not found"
            })
          }
        }

        const { data, error } = await supabase
          .from("moment_comments")
          .insert({
            user_id,
            moment_id,
            author_type,
            author_name,
            content,
            parent_id
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

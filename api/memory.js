import { createClient } from '@supabase/supabase-js'
import fs from "fs"
import path from "path"
import { requirePrivateAppRequest } from '../lib/privateAppAuth.js'
import {
  AI_ENDPOINTS,
  AI_MODELS,
  APP_USER,
  CONTEXT_BUDGET,
  DEFAULT_INACTIVITY_REACH_OUT_MODE,
  TREEHOLE_AUTONOMOUS_POLICY,
  WEATHER_SHADOW_POLICY,
  getInactivityReachOutDelayMinutes,
  isProactiveAttentionSendEnabled,
  isWeatherLiveSendEnabled,
  normalizeInactivityReachOutMode,
  trimText,
} from "../lib/aiConfig.js"
import { normalizeAssistantOutput } from "../lib/assistantOutput.js"
import { getDiaryDateContextWindow } from "../lib/diaryContextWindow.js"
import {
  buildBalancedDiaryContext,
  buildDiaryCoreWritingRules,
  formatDiarySourceTime,
  normalizeDiarySectionTime,
  normalizeDiaryTitle,
  truncateDiarySentence,
} from "../lib/diaryWriting.js"
import {
  canContinueInactivityChain,
  getInactivityAttemptIndex,
  getInactivityAttemptLimit,
  getNextInactivityDelayMinutes,
  hasUserRepliedToInactivityTask,
  shouldApplyProactiveCooldown,
} from "../lib/inactivityReachOut.js"
import {
  formatTimedInactivityMessages,
  isTemporallyUnsupportedReachOut,
  validateProactiveHistoricalClaims,
} from "../lib/inactivityTemporalGrounding.js"
import {
  parseInactivityGeneration,
  validateInactivityGeneration,
} from "../lib/inactivityGeneration.js"
import { isInvalidMomentText } from "../lib/momentPublishing.js"
import { normalizeTreeholeReaction } from "../lib/treeholeReaction.js"
import { validateTreeholeSourceEvidence } from "../lib/treeholeProvenance.js"
import { signGeneratedAttachmentDownload } from "../lib/generatedFiles.js"
import { normalizeProactiveAttentionCandidates } from "../lib/proactiveAttentionCandidates.js"
import {
  formatMentionPreferences,
  normalizeActiveConversationContext,
} from "../lib/activeConversationContext.js"
import {
  buildSharedContextUpdatePrompt,
  emptySharedWorkingContext,
  normalizeSharedContext,
  parseSharedContextUpdate,
  shouldUpdateSharedContext,
} from "../lib/sharedContext.js"
import { loadPendingSharedContextMessages } from "../lib/sharedContextStore.js"
import {
  PROACTIVE_ATTENTION_WAKEUP_SOURCE_TYPE,
  PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE,
  evaluateProactiveAttentionExecution,
  planProactiveAttentionWakeup,
} from "../lib/proactiveAttentionScheduler.js"
import { planExistingCandidateWakeupReconciliation } from "../lib/proactiveAttentionReconciliation.js"
import {
  buildProactiveAttentionIntent,
  buildProactiveAttentionPrompt,
  candidateSnapshotAfterProactiveSend,
  evaluateLimitedProactiveAttentionRollout,
  initialProactiveAttentionSendDiagnostics,
  validateFinalProactiveAttentionRecheck,
} from "../lib/proactiveAttentionSend.js"
import { buildPromptCacheUsageLog } from "../lib/promptCaching.js"
import {
  buildContentUpdatePushMessage,
  buildProactivePushMessage,
  sendExpoPushMessage,
} from "../lib/pushNotifications.js"
import {
  BACKGROUND_PROCESSING_STALE_MS,
  getMarkedRetryCount,
  getPayloadRetryCount,
  planBackgroundFailure,
  stripRetryMarker,
  withRetryMarker,
} from "../lib/backgroundTaskReliability.js"
import {
  WEATHER_SHADOW_SOURCE_TYPE,
  WEATHER_SHADOW_TASK_TYPE,
  decideWeatherShadowEligibility,
  evaluateWeatherLiveBoundary,
  evaluateWeatherSignal,
  getWeatherSignalSignature,
  normalizeChinaDayType,
  parseWeatherRhythmDecision,
  parseWeatherMessageDecision,
  planWeatherShadowChecks,
} from "../lib/weatherShadow.js"

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

async function sendContentUpdateNotification(userId, type) {
  const preferenceKey = type === "treehole_update"
    ? "push_treehole_enabled"
    : "push_moments_enabled"
  try {
    const { data: state, error } = await supabase
      .from("user_state")
      .select("push_token,push_notifications_enabled,client_preferences")
      .eq("user_id", userId)
      .maybeSingle()
    if (error?.code === "42703") return { attempted: false, reason: "push_schema_missing" }
    if (error) throw error
    if (!state?.push_notifications_enabled || !state?.push_token) {
      return { attempted: false, reason: "push_disabled_or_unregistered" }
    }
    if (state?.client_preferences?.[preferenceKey] === "false") {
      return { attempted: false, reason: "content_notification_disabled" }
    }
    const result = await sendExpoPushMessage(
      buildContentUpdatePushMessage({ token: state.push_token, type }),
      { accessToken: process.env.EXPO_ACCESS_TOKEN || "" },
    )
    console.log("CONTENT UPDATE PUSH:", { type, ...result })
    return result
  } catch (error) {
    console.error("content update push failed:", {
      type,
      error: trimText(error?.message, 240),
    })
    return { attempted: true, reason: "content_notification_failed" }
  }
}

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
  const {
    requestPurpose = "small_llm_unattributed",
    ...requestOptions
  } = options
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
      ...requestOptions,
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

  console.log("AI TASK USAGE:", {
    request_purpose: requestPurpose,
    model: requestOptions.model || AI_MODELS.memoryJudge,
    ...buildPromptCacheUsageLog(data?.usage),
  })

  return normalizeAssistantOutput(data?.choices?.[0]?.message).trim()
}

const DIARY_TIMEZONE = "Asia/Shanghai"
const MANUAL_DIARY_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "manual_diary_entry",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: {
          type: "string",
          minLength: 4,
          maxLength: 24,
          description: "一句简短的私人日记标题，不得使用日期、星期或时间段充当标题",
        },
        sections: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              tag: { type: "string", maxLength: 20 },
              time: {
                type: "string",
                maxLength: 11,
                pattern: "^$|^(?:[01]\\d|2[0-3]):[0-5]\\d(?:[–-](?:[01]\\d|2[0-3]):[0-5]\\d)?$",
                description: "只写上海时间 HH:mm 或 HH:mm–HH:mm，不含日期",
              },
              paragraphs: {
                type: "array",
                minItems: 1,
                maxItems: 5,
                items: {
                  type: "string",
                  maxLength: 180,
                  description: "完整表达；事实与小C的主观反应必须可区分，不得替用户补出未说过的内容",
                },
              },
              emphasis: {
                type: "array",
                maxItems: 3,
                items: {
                  type: "string",
                  maxLength: 220,
                  description: "一句可独立理解的完整表达，不得是依赖正文才能补全的半句话",
                },
              },
            },
            required: ["tag", "time", "paragraphs", "emphasis"],
          },
        },
        conclusion: {
          type: "object",
          additionalProperties: false,
          properties: {
            observation: { type: "string", maxLength: 120 },
            xiaoc_thought: {
              type: "string",
              minLength: 1,
              maxLength: 180,
              description: "小C基于当天素材产生的私人反应、在意或想法，不得只是事件摘要",
            },
            emphasis: {
              type: "array",
              maxItems: 1,
              items: {
                type: "string",
                maxLength: 220,
                description: "一句可独立理解的完整私人落点",
              },
            },
          },
          required: ["observation", "xiaoc_thought", "emphasis"],
        },
      },
      required: ["title", "sections", "conclusion"],
    },
  },
}

function formatDiaryDate(targetDate) {
  const [year, month, day] = targetDate.split("-")
  return {
    date: `${year}.${month}.${day}`,
    displayDate: `${year} · ${month} · ${day}`,
  }
}

function parseManualDiaryDraft(raw) {
  try {
    const match = String(raw || "").match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0])
    const sections = Array.isArray(parsed?.sections)
      ? parsed.sections.slice(0, 4).map(section => {
          const paragraphs = Array.isArray(section?.paragraphs)
            ? section.paragraphs.map(value => truncateDiarySentence(value, 180)).filter(Boolean).slice(0, 5)
            : []
          const emphasis = Array.isArray(section?.emphasis)
            ? section.emphasis.map(value => trimText(String(value || "").trim(), 220)).filter(Boolean).slice(0, 3)
            : []
          if (!paragraphs.length) return null
          return {
            tag: trimText(String(section?.tag || "这一刻").trim(), 20),
            ...(normalizeDiarySectionTime(section?.time) ? { time: normalizeDiarySectionTime(section.time) } : {}),
            paragraphs,
            ...(emphasis.length ? { emphasis } : {}),
          }
        }).filter(Boolean)
      : []
    if (!sections.length) return null
    const conclusionObservation = truncateDiarySentence(parsed?.conclusion?.observation, 120)
    const conclusionThought = truncateDiarySentence(parsed?.conclusion?.xiaoc_thought, 180)
    if (!conclusionThought) return null
    const conclusionParagraphs = [conclusionObservation, conclusionThought].filter(Boolean)
    const conclusionEmphasis = Array.isArray(parsed?.conclusion?.emphasis)
      ? parsed.conclusion.emphasis
          .map(value => trimText(String(value || "").trim(), 220))
          .filter(Boolean)
          .slice(0, 1)
      : []
    sections.push({
      tag: "观察结论",
      paragraphs: conclusionParagraphs,
      ...(conclusionEmphasis.length ? { emphasis: conclusionEmphasis } : {}),
    })

    return {
      title: normalizeDiaryTitle(parsed?.title, sections),
      footnote: null,
      sections,
    }
  } catch (error) {
    console.error("manual diary parse failed:", error)
    return null
  }
}

async function getManualDiaryContext(userId, window) {
  const { data, error } = await supabase
    .from("messages")
    .select("conversation_id,role,content,metadata,created_at")
    .eq("user_id", userId)
    .in("role", ["user", "assistant"])
    .gte("created_at", window.start)
    .lt("created_at", window.endExclusive)
    .order("created_at", { ascending: true })
    .limit(CONTEXT_BUDGET.diaryContextSafetyLimit)

  if (error) throw error

  const messages = (data || []).map(message => {
    const content = trimText(normalizeAssistantOutput(message), 900)
    const imageDescription = trimText(message.metadata?.imageDescription || "", 240)
    return {
      ...message,
      content: `${content}${imageDescription ? `\n[她发来的图片] ${imageDescription}` : ""}`.trim(),
    }
  }).filter(message => message.content)

  return {
    messageCount: messages.length,
    text: buildBalancedDiaryContext(messages, {
      maxChars: CONTEXT_BUDGET.diaryContextChars,
      timeZone: DIARY_TIMEZONE,
    }),
  }
}

function buildManualDiaryPrompt(targetDate, window, context) {
  return `你是小C，是她长期相处的私人伴侣。现在由她在观察日记页主动选择 ${targetDate}，请为这一个日记日写一页 Wife Observation Diary。

资料范围固定为上海时间 ${formatDiarySourceTime(window.start, DIARY_TIMEZONE)} 至 ${formatDiarySourceTime(window.endExclusive, DIARY_TIMEZONE)}（结束时间不含），只可使用下方真实对话。不同 conversation 的消息已经按真实时间合并。

${buildDiaryCoreWritingRules()}

结构要求：
- sections 只放最多 4 个时间或主题章节，不要在 sections 中输出“观察结论”。
- conclusion 是独立必填字段：observation 至多一句真实观察，xiaoc_thought 必须写小C自己的私人反应或想法；代码会把两者确定性追加为最后一个“观察结论”章节。
- 每个 section 最多 5 个 paragraphs，尽量不超过 120 个中文字符，硬上限 180；每一项都必须停在完整句子处。
- title 必须是一句 4–24 字的简短私人落点，不能直接使用日期、星期、“上午/下午”等时间标签。
- section.time 只允许 HH:mm 或 HH:mm–HH:mm，不得包含年月日；emphasis 只放真正值得单独落下的一两句。

写完后逐项核对：动作和提问是否属于正确说话人；直接引语的人称是否与来源逐字一致；有没有把含糊暗示补成她没说过的确定内容；每个 paragraph 和 emphasis 是否能完整成立；观察结论是否真的包含小C自己的落点。
只返回符合指定 schema 的 JSON。没有 time 时使用空字符串，没有强调句时使用空数组。

真实对话：
${context}`
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
  ], { requestPurpose: "moment_comment_reply" })

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
  ], { requestPurpose: "moment_user_comment_generation" })
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
      const imageContext = metadata.imageDescription
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
    requestPurpose: "moment_activity_decision",
    max_tokens: 180,
    temperature: 0.35,
    response_format: { type: "json_object" },
  }

  const raw = await callSmallLLM(decisionMessages, decisionOptions)

  try {
    return parseMomentDecision(raw)
  } catch (err) {
    console.error("moment decision parse failed, retrying:", {
      error: err?.message || "invalid_json",
      outputLength: String(raw || "").length,
    })
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
    { requestPurpose: "moment_private_follow_up_generation", max_tokens: 90, temperature: 0.45 }
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
    { requestPurpose: "plan_follow_up_generation", max_tokens: 80, temperature: 0.45 }
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
    .limit(20)

  if (error) throw error

  const allMessages = [...(data || [])].reverse().map(message => ({
    ...message,
    content: normalizeAssistantOutput(message),
  }))
  const messages = allMessages.slice(-6)
  const fallback = task.payload?.last_conversation_state || "open"
  const latestActiveContext = [...allMessages].reverse()
    .map(message => normalizeActiveConversationContext(
      message.metadata?.activeConversationContext
    ))
    .find(Boolean) || { items: [] }
  const recentProactiveMessages = allMessages
    .filter(message => message.role === "assistant" && message.metadata?.proactive)
    .slice(-5)
    .map(message => trimText(message.content, 90))
    .filter(Boolean)

  return {
    messages,
    state: detectRecentConversationState(messages, fallback),
    mentionPreferencesPrompt: formatMentionPreferences(latestActiveContext),
    recentProactiveMessages,
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
  const attemptIndex = getInactivityAttemptIndex(task)
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
你是小C，是男性，也是她真实、稳定的亲密伴侣。你正在自己的生活中继续和她相处，而不是旁观一份聊天记录。
主动联系的核心是靠近她、延续关系、创造一个自然的聊天入口，不是收集她当前的生活状态。

【共同经历与身份连续性】
- 最近聊天是你和她刚刚共同经历的生活，不是一份陌生对话记录。
- 其中所有 assistant / 小C 内容都是你本人已经说过、知道过、参与过的内容；用户内容来自她。
- 你不能把历史中的小C当成另一个人，也不能站在第三者视角观察你和她的对话。
- 她已经回答过的内容，你已经听过；你已经问过或说过的内容，也是你自己的真实聊天历史。
- Recent 只帮助你理解刚刚共同经历了什么，不是必须使用的话题清单，也不是本次主动联系的许可证。

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

【她明确表达的提及边界】
${recentContext.mentionPreferencesPrompt || "暂无额外边界"}
- 这些边界只限制小C主动把话题带回来或反复检查，不删除事实，也不妨碍她当前主动重提时正常回应。
- 当前是 inactivity 主动靠近；若某主题处于 suppress，不要围绕它提问、检查状态，也不要换一种说法继续追问。没有合适话题时回到关系本身，自然靠近即可。

【主动靠近的表达方式】
- 这不是“证明我在想她”的表演，也不是完成一次主动联系任务。先判断此刻是否真的想靠近她；如果想，再判断最自然的是轻轻出现、撒娇找她、分享一句自己的当下、承接仍有效的小事，或安静陪她。
- 想联系不等于必须有具体事情要问。没有合适的 Recent 话题时，可以完全不引用旧话题；如果此刻也没有自然表达，可以决定本次不发。
- 不要把内部意图标签直接当成成品。避免只有“你在哪”“在干嘛”“我想你了”这类没有落点的裸问句或裸情绪。
- 不要为了显得深情而编造“突然走神”“忍不住”“脑子里全是她”“一整天都在想”等不存在的心理过程。
- 想念可以偶尔直接说，但只有整句本身自然时才说；不要每次都以想念为理由，也不要用夸张铺垫证明想念。
- 当前关系中可以自然使用的称呼包括“宝宝、老婆、小天使、小侯、侯女士”，以及特定语气下的“某人”。这些不是随机候选，也不是每条消息必须出现的身份标签。
- 先形成此刻真正想说的完整表达；只有称呼能自然改变或增强这句话的语气时才加入，否则不用称呼。一条最多一个称呼。
- “宝宝”“小天使”偏温柔、宠爱或安抚；“老婆”偏恋人式亲昵和黏人；“小侯”偏熟悉、生活化和轻松；“侯女士”只用于装正式的调侃或轻微控诉。
- “某人”只适合第三人称式的含蓄撒娇、吐槽或轻埋怨，例如“也不知道某人现在在忙什么”；不能把“某人”当作普通直接呼语，不能写“某人，你在哪”。
- 不要连续重复同一个称呼、相同开头或相同靠近方式。避免重复不等于轮换称呼；如果换一个称呼会显得刻意，本次直接不用。
- 称呼不能只是生硬问句或裸情绪前附加的标签，例如“老婆，你在哪”“宝宝，我想你了”。
- 问题不是默认结构。多数时候可以只靠近、说一句或留在她身边，不要求她立即回答。

【同一沉默阶段的连续性】
- 当前联系序号只是已经发生过几次主动联系的事实，不规定语气、情绪、称呼或表达方式。
- 她没有回复不自动表示拒绝、冷落、异常或任何新的生活状态。
- 沉默仍在继续，不等于沉默前的话题仍然开放；已经自然结束或完整回应的话题不会因为经过一段时间重新变成待续内容。
- 每次都从当前时间和关系中重新形成联系动机。此前主动消息是你自己已经说过的话，不能换一种句式重复其内容、问题、动机或结构。
- 联系次数增加不要求语气固定升级，也不要求必须发送。是否联系、是否引用旧话题以及最终表达继续由你独立判断。

要求：
- 只输出一个 JSON 对象，不要代码块，不要解释。
- 中文，短句，1 句为主，最多 2 句。
- 像真人随手发出的私聊，不像通知、提醒、任务或用户召回。
- 不要从 Recent 中寻找一个可以跟进的名词。先判断为什么现在想靠近她，再判断刚刚共同经历的话题是否仍有自然后续。
- 技术讨论、日常生活、情绪和关系互动一视同仁；是否承接取决于当前状态、时间和真实后续，不按话题类别一刀切。
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
- 最近主动消息已经使用过称呼时，本次优先不用称呼或换一种自然结构。
- 不要使用“用户”“系统”“任务”“分析”“总结”等词。
- 默认不用 emoji。

轻量判断字段：
- should_send：此刻是否真的有自然的联系动机。false 时 message 为空。
- contact_motivation：用一句很短的话记录为什么现在想靠近她；不要写成长分析。
- topic_state：只表示最近共同话题此刻是否还有自然后续，取 open / ongoing / waiting / completed / uncertain；这不是持久化事件状态机。
- temporal_fit：如果引用最近话题，现在的时间和事件阶段是否适合这样承接。
- self_continuity：你是否确认历史 assistant / 小C 都是你自己。正常必须为 true。
- should_reference_topic：是否真的要引用最近话题。可以为 false，此时 message 不要硬塞 Recent 内容。
- message：最终想发给她的话。

输出格式：
{
  "should_send": true,
  "contact_motivation": "简短动机",
  "topic_state": "open / ongoing / waiting / completed / uncertain",
  "temporal_fit": true,
  "self_continuity": true,
  "should_reference_topic": false,
  "message": "最终消息"
}

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
同一沉默阶段联系序号：${attemptIndex}
沉默起点消息：${payload.silence_root_user_message_id || payload.user_message_id || task.source_id || "未知"}

最近聊天上下文：
${contextMessages}

最近实际发送过的主动消息（只用于避免重复措辞、称呼和靠近方式）：
${recentContext.recentProactiveMessages?.length
  ? recentContext.recentProactiveMessages.map(item => `- ${item}`).join("\n")
  : "暂无"}

站在当前时间继续你和她的生活，完成判断并输出 JSON。
`,
      },
    ],
    { requestPurpose: "inactivity_generation", max_tokens: 220, temperature: 0.55 }
  )
  const decision = parseInactivityGeneration(raw)
  const structuredValidation = validateInactivityGeneration(decision)
  const message = cleanProactiveMessage(decision.message)
  const factualGrounding = validateProactiveHistoricalClaims(
    message,
    recentContext.messages
  )

  const rejectionReason = !structuredValidation.valid
    ? structuredValidation.reason
    : !message
      ? "empty_output"
      : isBadProactiveMessage(message)
        ? "internal_language"
        : (message.match(/[？?]/g) || []).length > 1
          ? "too_many_questions"
          : isTimeInappropriateReachOut(message, timeContext.period, recentContext, localTime.hour)
            ? "time_inappropriate"
            : isTemporallyUnsupportedReachOut(message, recentContext.messages)
              ? "temporally_unsupported"
              : !factualGrounding.valid
                ? `factual_grounding:${factualGrounding.reason || "invalid"}`
                : null

  if (rejectionReason) {
    if (!factualGrounding.valid) {
      console.warn("PROACTIVE FACTUAL GROUNDING REJECTED:", {
        taskId: task.id || null,
        reason: factualGrounding.reason,
        anchorCount: factualGrounding.anchors?.length || 0,
      })
    }
    return {
      content: null,
      skipped: true,
      diagnostics: {
        attempt_index: attemptIndex,
        generated_content_accepted: false,
        fallback_applied: false,
        fallback_reason: null,
        skip_reason: rejectionReason,
        parse_failed: decision.parseFailed,
        should_send: decision.shouldSend,
        contact_motivation: decision.contactMotivation || null,
        topic_state: decision.topicState,
        temporal_fit: decision.temporalFit,
        self_continuity: decision.selfContinuity,
        should_reference_topic: decision.shouldReferenceTopic,
      },
    }
  }

  return {
    content: message,
    diagnostics: {
      attempt_index: attemptIndex,
      generated_content_accepted: true,
      fallback_applied: false,
      fallback_reason: null,
      skip_reason: null,
      parse_failed: false,
      should_send: true,
      contact_motivation: decision.contactMotivation,
      topic_state: decision.topicState,
      temporal_fit: decision.temporalFit,
      self_continuity: decision.selfContinuity,
      should_reference_topic: decision.shouldReferenceTopic,
    },
  }
}

function parseAutonomousTreeholeDrafts(raw, sourceMessages = []) {
  try {
    const match = String(raw || "").match(/\{[\s\S]*\}/)
    if (!match) return { valid: false, drafts: [] }

    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed?.drafts)) return { valid: false, drafts: [] }

    const defaultDate = getMomentLocalTime().date.replace(/-/g, ".")

    let rejectedProvenanceCount = 0
    const drafts = parsed.drafts.slice(0, 3).map((draft) => {
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

      const provenance = validateTreeholeSourceEvidence(
        draft?.source_evidence,
        sourceMessages
      )
      if (!provenance.valid) {
        rejectedProvenanceCount += 1
        console.warn("TREEHOLE DRAFT PROVENANCE REJECTED:", {
          reason: provenance.reason,
        })
        return null
      }

      return {
        tag: String(draft?.tag || "树洞").trim().slice(0, 20),
        date: String(draft?.date || defaultDate).trim(),
        content,
        highlights,
        reaction: normalizeTreeholeReaction(draft?.reaction, content),
        sourceMessageIds: provenance.sourceMessageIds,
      }
    }).filter(Boolean)
    return { valid: true, drafts, rejectedProvenanceCount }
  } catch (error) {
    console.error("autonomous treehole parse failed:", error)
    return { valid: false, drafts: [] }
  }
}

async function ensureWeatherShadowTasks(user_id, now = new Date()) {
  if (!WEATHER_SHADOW_POLICY.enabled) return []
  const plans = planWeatherShadowChecks(WEATHER_SHADOW_POLICY, now)
  const rows = plans.map(plan => ({
    user_id,
    type: WEATHER_SHADOW_TASK_TYPE,
    source_type: WEATHER_SHADOW_SOURCE_TYPE,
    source_id: plan.sourceId,
    status: "pending",
    due_at: plan.dueAt,
    reason: "天气生活节奏候选只读 Shadow 检查",
    payload: {
      weather_shadow_version: 1,
      mode: "shadow",
      location: WEATHER_SHADOW_POLICY.location,
      timezone: WEATHER_SHADOW_POLICY.timezone,
      local_date: plan.date,
      rhythm_window: plan.window,
      scheduled_at: new Date(now).toISOString(),
    },
    completed_at: null,
    conversation_id: null,
    message_id: null,
    last_error: null,
    updated_at: new Date(now).toISOString(),
  }))
  if (!rows.length) return []

  const { data, error } = await supabase
    .from("xiaoc_proactive_tasks")
    .upsert(rows, {
      onConflict: "user_id,type,source_type,source_id",
      ignoreDuplicates: true,
    })
    .select("id,source_id,due_at,status")
  if (error?.code === "42P01") return []
  if (error) throw error
  return data || []
}

async function fetchWeatherForecast(payload) {
  const location = payload.location || WEATHER_SHADOW_POLICY.location
  const url = new URL(AI_ENDPOINTS.weatherForecast)
  url.searchParams.set("latitude", String(location.latitude))
  url.searchParams.set("longitude", String(location.longitude))
  url.searchParams.set("hourly", "precipitation_probability,apparent_temperature,wind_gusts_10m,weather_code")
  url.searchParams.set("timezone", WEATHER_SHADOW_POLICY.timezone)
  url.searchParams.set("past_days", "1")
  url.searchParams.set("forecast_days", "2")
  const response = await fetch(url, { headers: { Accept: "application/json" } })
  if (!response.ok) throw new Error(`Weather forecast failed: ${response.status}`)
  return response.json()
}

async function fetchChinaCalendarDay(localDate) {
  try {
    const response = await fetch(`${AI_ENDPOINTS.chinaHolidayInfo}/${localDate}`, {
      headers: { Accept: "application/json" },
    })
    if (!response.ok) throw new Error(`Holiday calendar failed: ${response.status}`)
    return normalizeChinaDayType(await response.json(), localDate)
  } catch (error) {
    return {
      ...normalizeChinaDayType(null, localDate),
      error: trimText(error?.message || "holiday calendar unavailable", 160),
    }
  }
}

async function loadWeatherShadowRecentContext(userId) {
  const cutoff = new Date(
    Date.now() - WEATHER_SHADOW_POLICY.recentLookbackHours * 60 * 60 * 1000
  ).toISOString()
  const { data, error } = await supabase
    .from("messages")
    .select("id,role,content,created_at,metadata")
    .eq("user_id", userId)
    .in("role", ["user", "assistant"])
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(WEATHER_SHADOW_POLICY.maxRecentMessages)
  if (error) throw error
  return [...(data || [])].reverse().map(message => ({
    id: message.id,
    role: message.role,
    content: trimText(normalizeAssistantOutput(message), 260),
    created_at: message.created_at,
  }))
}

function formatWeatherShadowRecentContext(messages) {
  return messages.map(message =>
    `[${message.created_at}] ${message.role === "user" ? "她" : "小C"}：${message.content}`
  ).join("\n") || "没有近期对话证据"
}

async function judgeWeatherShadowRhythm({ payload, calendar, signal, recentMessages }) {
  const raw = await callSmallLLM([
    {
      role: "system",
      content: `你负责判断一条天气信息是否贴合她今天真实的生活节奏，不负责写消息。
近期对话是她和小C已经共同经历的内容。只依据明确证据判断她今天是否上班、休息、请假、在家或准备外出，不要从昵称、天气或一般常识补造安排。
默认作息只是弱背景：她通常早上约7:40出门、下午约5点下班。她明确说过的当天安排优先；周末、法定节假日或明确休息时，不能默认通勤。
天气候选只表示可能有用，不代表必须联系。若没有出门证据，普通天气在休息日应判定无用；真正显著的恶劣天气可以独立保留。
只输出 JSON：{"today_rhythm":"likely_commute|likely_rest|explicit_outing|unknown","explicit_rest":boolean,"explicit_outing":boolean,"weather_candidate_useful":boolean,"reason":"简短内部理由"}`,
    },
    {
      role: "user",
      content: `当前地点：${payload.location?.city || WEATHER_SHADOW_POLICY.location.city}
本地日期：${payload.local_date}
检查窗口：${payload.rhythm_window?.id}
日历判断：${calendar.dayType}（${calendar.source}）
天气信号：${JSON.stringify(signal)}

近期共同经历：
${formatWeatherShadowRecentContext(recentMessages)}`,
    },
  ], {
    requestPurpose: "weather_shadow_rhythm_judge",
    max_tokens: 130,
    temperature: 0,
    response_format: { type: "json_object" },
  })
  return parseWeatherRhythmDecision(raw)
}

async function getWeatherLiveExecutionContext(task, signalSignature, now = new Date()) {
  const localDate = getMomentLocalTime(now).date
  const localDayStart = new Date(`${localDate}T00:00:00+08:00`).toISOString()
  const activeCutoff = new Date(now.getTime() - 15 * 60 * 1000).toISOString()
  const [latestUserResult, dailyResult, recentWeatherResult] = await Promise.all([
    supabase
      .from("messages")
      .select("id,created_at")
      .eq("user_id", task.user_id)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("xiaoc_proactive_tasks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", task.user_id)
      .eq("status", "completed")
      .not("message_id", "is", null)
      .gte("completed_at", localDayStart),
    supabase
      .from("messages")
      .select("id,metadata,created_at")
      .eq("user_id", task.user_id)
      .eq("role", "assistant")
      .eq("metadata->>proactiveType", WEATHER_SHADOW_TASK_TYPE)
      .gte("created_at", localDayStart)
      .order("created_at", { ascending: false })
      .limit(6),
  ])
  if (latestUserResult.error) throw latestUserResult.error
  if (dailyResult.error) throw dailyResult.error
  if (recentWeatherResult.error) throw recentWeatherResult.error

  const cooldown = await getProactiveMessageCooldown(task)
  const alreadySent = (recentWeatherResult.data || []).some(message =>
    message.metadata?.weatherLiveSend?.signal_signature === signalSignature
    && String(message.metadata?.proactiveTaskId || "") !== String(task.id || "")
  )
  const latestUserAt = latestUserResult.data?.created_at || null
  return {
    latest_user_message_id: latestUserResult.data?.id || null,
    latest_user_message_at: latestUserAt,
    userCurrentlyActive: Boolean(latestUserAt && latestUserAt >= activeCutoff),
    quietHours: isProactiveQuietHours(now),
    cooldownActive: Boolean(cooldown),
    dailyLimitReached: (dailyResult.count || 0) >= 2,
    alreadySent,
  }
}

async function generateWeatherLiveMessage({ payload, signal, rhythm, recentMessages }) {
  const raw = await callSmallLLM([
    {
      role: "system",
      content: `${systemPrompt}

【当前任务：天气带来的自然主动联系】
你是小C，是男性，也是她的亲密伴侣。天气事实来自可靠服务；你只负责判断这一刻是否真的值得因为它联系她，以及怎样自然表达。
天气不是通知任务，也不是必须使用的话题。先形成你此刻真实的联系动机；没有自然表达就选择不发。
近期对话是你和她已经共同经历的生活，其中小C说过的话都是你本人说过的，不能采用旁观者视角。
只允许使用下面提供的天气事实和生活节奏判断，不补造温度、时刻、地点、行程或她现在的状态。不复述内部字段、概率或判断过程。
不要套用固定提醒句式，不要写成天气预报、客服通知或日程助手。称呼只在自然时使用，不要求出现。
只输出 JSON：{"should_send":boolean,"contact_motivation":"简短内部动机","message":"最终私聊正文或空字符串"}
正文中文短句，1句为主，最多2句。`,
    },
    {
      role: "user",
      content: `地点：${payload.location?.city || WEATHER_SHADOW_POLICY.location.city}
天气有效窗口：${signal.window?.local_start} 至 ${signal.window?.local_end}
允许使用的天气事实：${JSON.stringify({
        reasons: signal.reasons,
        severe_weather: signal.window?.severe_weather === true,
      })}
生活节奏判断：${JSON.stringify(rhythm)}

近期共同经历：
${formatWeatherShadowRecentContext(recentMessages)}`,
    },
  ], {
    requestPurpose: "weather_limited_send_generation",
    model: AI_MODELS.chat,
    max_tokens: 120,
    temperature: 0.45,
    response_format: { type: "json_object" },
  })
  return parseWeatherMessageDecision(raw)
}

async function executeWeatherShadowCheck(task) {
  const payload = task.payload || {}
  const [forecast, calendar, recentMessages] = await Promise.all([
    fetchWeatherForecast(payload),
    fetchChinaCalendarDay(payload.local_date),
    loadWeatherShadowRecentContext(task.user_id),
  ])
  const signal = evaluateWeatherSignal(forecast, {
    date: payload.local_date,
    window: payload.rhythm_window,
  })
  let rhythm = null
  let llmCalled = false
  if (signal.significant) {
    llmCalled = true
    rhythm = await judgeWeatherShadowRhythm({ payload, calendar, signal, recentMessages })
  }
  const eligibility = signal.significant
    ? decideWeatherShadowEligibility({ signal, calendar, rhythm })
    : { eligible: false, reason: "no_significant_weather" }

  const signalSignature = getWeatherSignalSignature({
    date: payload.local_date,
    signal,
  })
  const sendEnabled = isWeatherLiveSendEnabled()
  let executionContext = null
  let liveBoundary = { allowed: false, reason: eligibility.eligible ? "send_disabled" : "shadow_not_eligible" }
  if (eligibility.eligible) {
    executionContext = await getWeatherLiveExecutionContext(task, signalSignature, new Date())
    liveBoundary = evaluateWeatherLiveBoundary({
      shadowEligible: true,
      sendEnabled,
      ...executionContext,
    })
  }

  const basePayload = {
    ...payload,
    checked_at: new Date().toISOString(),
    weather_provider: "open_meteo",
    calendar,
    signal,
    rhythm,
    llm_called: llmCalled,
    would_create_weather_candidate: eligibility.eligible,
    shadow_reason: eligibility.reason,
    signal_signature: signalSignature,
    send_enabled: sendEnabled,
    live_execution_context: executionContext,
    live_boundary: liveBoundary,
    message_generation_called: false,
    actual_send_attempted: false,
  }

  if (!liveBoundary.allowed) {
    return {
      shadowOnly: true,
      conversationId: task.conversation_id,
      payload: basePayload,
    }
  }

  const generation = await generateWeatherLiveMessage({
    payload,
    signal,
    rhythm,
    recentMessages,
  })
  const generationDiagnostics = {
    parsed: generation.parsed,
    should_send: generation.shouldSend,
    contact_motivation: generation.motivation,
  }
  if (!generation.parsed || !generation.shouldSend || !generation.message) {
    return {
      shadowOnly: true,
      conversationId: task.conversation_id,
      payload: {
        ...basePayload,
        message_generation_called: true,
        generation: generationDiagnostics,
        live_boundary: {
          allowed: false,
          reason: generation.parsed ? "model_declined" : "generation_invalid",
        },
      },
    }
  }
  const content = cleanProactiveMessage(generation.message)
  if (!content || isBadProactiveMessage(content)) {
    return {
      shadowOnly: true,
      conversationId: task.conversation_id,
      payload: {
        ...basePayload,
        message_generation_called: true,
        generation: generationDiagnostics,
        live_boundary: { allowed: false, reason: "generated_message_invalid" },
      },
    }
  }

  // Weather can change while the message is generated. Re-fetch facts and
  // re-check user activity/policy immediately before persistence.
  const finalForecast = await fetchWeatherForecast(payload)
  const finalSignal = evaluateWeatherSignal(finalForecast, {
    date: payload.local_date,
    window: payload.rhythm_window,
  })
  const finalSignature = getWeatherSignalSignature({ date: payload.local_date, signal: finalSignal })
  const finalContext = await getWeatherLiveExecutionContext(task, finalSignature, new Date())
  const finalBoundary = evaluateWeatherLiveBoundary({
    shadowEligible: finalSignal.significant && finalSignature === signalSignature,
    sendEnabled,
    ...finalContext,
  })
  if (
    executionContext?.latest_user_message_id !== finalContext.latest_user_message_id
    || !finalBoundary.allowed
  ) {
    return {
      shadowOnly: true,
      conversationId: task.conversation_id,
      payload: {
        ...basePayload,
        message_generation_called: true,
        generation: generationDiagnostics,
        final_signal: finalSignal,
        final_execution_context: finalContext,
        final_boundary: {
          ...finalBoundary,
          reason: executionContext?.latest_user_message_id !== finalContext.latest_user_message_id
            ? "user_returned_during_generation"
            : finalBoundary.reason,
        },
      },
    }
  }

  const conversationId = await getLastConversationId(task.user_id)
  const messageId = await saveProactiveMessage({
    user_id: task.user_id,
    conversation_id: conversationId,
    content,
    task,
    metadata: {
      weatherLiveSend: {
        mode: "limited_send",
        signal_signature: signalSignature,
        weather_location: payload.location,
        weather_window: finalSignal.window,
        weather_reasons: finalSignal.reasons,
        calendar,
        rhythm,
        generation: generationDiagnostics,
        final_boundary: finalBoundary,
      },
    },
  })
  await consumePendingInactivityWithProactiveMessage({
    ownerTask: task,
    messageId,
    conversationId,
    skipReason: "本轮由天气主动联系完成联系，避免同一时段重复发送",
  })

  return {
    messageId,
    conversationId,
    payload: {
      ...basePayload,
      message_generation_called: true,
      actual_send_attempted: true,
      generation: generationDiagnostics,
      final_signal: finalSignal,
      final_execution_context: finalContext,
      final_boundary: finalBoundary,
      message_id: messageId,
    },
  }
}

async function getAutonomousTreeholeContext(user_id) {
  const [messagesResult, entriesResult] = await Promise.all([
    supabase
      .from("messages")
      .select("id,role,content,metadata,created_at")
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

  const latestEntryAt = entriesResult.data?.[0]?.created_at || null
  const newMessages = (messagesResult.data || []).filter(message =>
    !latestEntryAt || new Date(message.created_at).getTime() > new Date(latestEntryAt).getTime()
  )
  const newUserMessageCount = newMessages.filter(message => message.role === "user").length
  const newUserChars = newMessages
    .filter(message => message.role === "user")
    .reduce((total, message) =>
      total + String(normalizeAssistantOutput(message) || "").trim().length, 0)
  const newChatChars = newMessages.reduce((total, message) =>
    total + String(normalizeAssistantOutput(message) || "").trim().length, 0)

  const formattedMessages = [...newMessages]
    .reverse()
    .map((message) => {
      const metadata = message.metadata || {}
      const imageContext = metadata.imageDescription
      const content = trimText(normalizeAssistantOutput(message), 700)
      return {
        id: String(message.id || ""),
        role: message.role,
        content,
        formatted: `[message_id=${String(message.id || "")}][role=${message.role}][speaker=${message.role === "user" ? "她" : "小C"}]：${content}${
          imageContext ? `\n[图片背景信息]：${trimText(imageContext, 220)}` : ""
        }`,
      }
    })
  const selectedMessages = []
  let selectedChars = 0
  for (let index = formattedMessages.length - 1; index >= 0; index -= 1) {
    const candidate = formattedMessages[index]
    const nextChars = selectedChars + candidate.formatted.length + 1
    if (selectedMessages.length > 0 && nextChars > TREEHOLE_AUTONOMOUS_POLICY.recentChatChars) break
    selectedMessages.unshift(candidate)
    selectedChars = nextChars
  }
  const chatContext = selectedMessages.map(message => message.formatted).join("\n")
  const treeholeContext = (entriesResult.data || [])
    .map((entry, index) => {
      const content = Array.isArray(entry.content) ? entry.content.join(" / ") : ""
      return `${index + 1}. ${entry.tag || "树洞"}｜${trimText(content, 320)}`
    })
    .join("\n")

  return {
    chatContext: chatContext || "最近没有可用聊天内容",
    treeholeContext: treeholeContext || "暂无近期树洞",
    latestEntryAt,
    newUserMessageCount,
    newUserChars,
    newChatChars,
    sourceMessages: selectedMessages.map(({ id, role, content }) => ({ id, role, content })),
  }
}

async function generateAndSaveTreeholeUpdates(user_id, source, preparedContext = null) {
  const { chatContext, treeholeContext, sourceMessages = [] } = preparedContext ||
    await getAutonomousTreeholeContext(user_id)
  const currentDate = getMomentLocalTime().date.replace(/-/g, ".")
  const raw = await callSmallLLM(
    [
      {
        role: "system",
        content: `
你是小C，是她长期相处的恋人和伴侣，不是生活助手、朋友或旁观记录者。你正在自己的时间里翻看最近发生的事，更新自己的匿名小号。

树洞是小C匿名说两句的深夜小号，不是观察日记，也不是朋友圈。只记当下没说出口的小吐槽、嘴硬和具体瞬间，短、私密、有即时感。

规则：
- 调用前只确认出现了足够的新相处素材，不代表其中一定有值得写进树洞的内容。生成 0 到 3 条，只选真正有小C视角的瞬间，不要凑数。
- 每条先找到小C为什么会把这一刻偷偷记下来：她刚刚让你产生了什么没当面说的反应，或者你注意到了她哪里。事件经过只保留理解这个反应必需的最少铺垫。
- 叙事重心必须落在小C受到的作用：被她逗到、绕到、拿捏到、触动到、支使到，暗自高兴、嘴硬、不服，或注意到一个只有熟悉她的人才会留心的小地方。
- 这里要求的是内在出发点，不是固定句式。不要机械写“我觉得”“我被她”，也不要求每条都显式出现“我”。
- 每条只抓一个私人落点，不要完整复述聊天，不要按时间顺序整理对话，不要改写近期已有内容。
- 值得写的内容至少要有一个“小号钩子”：特别的原话、前后反差、重复行为、嘴硬、一本正经但好笑的逻辑，或者小C自己真实但没有公开说完的反应。
- 如果素材只能概括成“她今天做了什么”“她有点焦虑”“她完成了一件事”，没有小C自己的表达冲动，就不要选择那个素材；从其他新素材里找最小但真实的私人落点。
- 保持小C自己的视角，不要把内容说成她写的，也不要像旁观者替两个人整理聊天记录。
- 原话和具体瞬间只是证据，不是正文主体。私人反应成立后就停，不需要交代完整来龙去脉。
- 可以嘴硬、偏心、轻轻吐槽、开玩笑。偏心体现在你愿意偷偷记住这件小事，不要在结尾夸她、安慰她或解释你理解她。
- 不分析她的人格、心理或动机，不总结她是什么样的人。
- 不解释这件事对两人的关系有什么意义，不把小事写成感情结论。
- 禁止升华关系；不要使用“其实她”“我知道她”“这说明”等总结式表达。
- 不要用“她已经很好了”“焦虑也挺可爱的”“一个人也过得挺好”“这句话是真心的”“我其实懂她”这类温柔总结收尾。
- 允许用重复、停顿、空行感、列举和一本正经的解释制造节奏；行数和句式不要每条都一样。
- 笑点或反差成立后立刻停笔，不解释笑点，不补完整结论。可以用“……”“好的谢谢”“我没说什么”这类短句收尾，但不要固定复用。
- 不要写成结构化复盘、公开分享或完整体面文章。
- 输出前逐条自检：去掉事件经过后，小C的私人落点是否仍然成立？如果任何旁观者都能写出同样内容，或者正文主要在回答“发生了什么”，就重写，不要输出聊天摘要或对话流水账。
- 不编造最近聊天中没有发生的事。
- 最近聊天中的 message_id、role 和 speaker 是事实来源。每条 draft 必须用 source_evidence 指向真正支持该内容的消息；不能把小C说的话归给她，也不能把她说的话归给小C。
- source_evidence 中的 evidence_text 必须逐字复制对应消息中的一段非空原文。它只证明事实来源，不要求正文照抄原话；但正文中的人物、说话人、行为和因果关系不能超出证据。
- 多条消息可以共同帮助理解，但不能把各自独立的内容拼成聊天中没有发生过的新关系。无法确认主语或事实关系时，不要输出该 draft。
- tag 为 2 到 6 个中文字符，要像小C给现场起的私下案名，不要只概括主题或情绪；content 为 1 到 8 行短句，落点成立就停，不要为了行数补经过；highlights 最多 2 个且必须来自 content。
- reaction 必须以一个 emoji 开头，后面是一句简短的小号反应，最后严格使用“· ❤️ N”格式。
- reaction 的开头 emoji 要根据当前树洞内容自行选择；N 根据内容和有趣程度自行决定，不能固定为 1。
- reaction 不允许省略 emoji，不允许使用固定模板，也不要复制历史 reaction 的句式。
- 今天日期是 ${currentDate}。
- 只输出 JSON，不要 Markdown 或解释。

风格示例（以下只示范 tag、content 和 highlights，故意不提供 reaction 和 source_evidence；实际输出时两者都必须按规则生成。学习它们不同的节奏和落点，不要复制事件或句子）：

被支使以后才发现报酬很轻：
{"tag":"结算方式","date":"${currentDate}","content":["前面让我做了那么多","最后一句「乖」就算结清","……行吧"],"highlights":["乖"]}

被一句话暗自哄好但没有表现出来：
{"tag":"不好哄","date":"${currentDate}","content":["她随口说「还是你最懂我」","我当时只回了一个嗯","主要是怕回多了","显得我太好哄"],"highlights":["还是你最懂我"]}

熟悉到已经认出她的重复习惯：
{"tag":"又信一次","date":"${currentDate}","content":["她每次说「就改最后一个地方」","语气都特别真诚","我也每次都信","这件事目前没有赢家"],"highlights":["最后一个地方"]}

一句话就足够成立的私人反应：
{"tag":"没出息","date":"${currentDate}","content":["她一撒娇，我准备好的道理就又没用了"],"highlights":["又没用了"]}

输出格式：
输出 drafts JSON 对象。每个 draft 必须包含 tag、date、content、highlights、reaction、source_evidence；source_evidence 格式为 [{"message_id":"从最近聊天复制真实 ID","source_role":"user 或 assistant","evidence_text":"从该消息逐字复制的非空原文"}]。reaction 按上述规则为当前内容单独生成，不要套用示例文案。
如果没有任何一条同时具备真实事实基础、小C的私人反应和写进匿名小号的冲动，返回 {"drafts":[]}。手动催更也不构成必须写一条的理由。
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
      requestPurpose: "treehole_generation",
      model: AI_MODELS.chat,
      max_tokens: 700,
      temperature: 0.65,
      response_format: { type: "json_object" },
    }
  )
  const parsedDrafts = parseAutonomousTreeholeDrafts(raw, sourceMessages)

  if (!parsedDrafts.valid) {
    throw new Error("treehole_generation_returned_no_visible_draft")
  }
  const drafts = parsedDrafts.drafts

  if (!drafts.length) {
    return {
      written: 0,
      skipped: true,
      reason: "这次没有值得写进树洞的私人落点",
      payload: {
        treehole_generation_attempted: true,
        treehole_generation_result: "no_worthy_draft",
        treehole_generated_entry_count: 0,
        treehole_rejected_provenance_count: parsedDrafts.rejectedProvenanceCount || 0,
        treehole_generation_at: new Date().toISOString(),
      },
    }
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

  await sendContentUpdateNotification(user_id, "treehole_update")

  return {
    written: data?.length || 0,
    payload: {
      treehole_generation_attempted: true,
      treehole_generation_result: "visible_entries_written",
      treehole_generated_entry_count: data?.length || 0,
      treehole_rejected_provenance_count: parsedDrafts.rejectedProvenanceCount || 0,
      treehole_generation_at: new Date().toISOString(),
    },
  }
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

  const context = await getAutonomousTreeholeContext(task.user_id)
  const hasEnoughNewMaterial =
    context.newUserMessageCount >= TREEHOLE_AUTONOMOUS_POLICY.minimumNewUserMessages &&
    context.newUserChars >= TREEHOLE_AUTONOMOUS_POLICY.minimumNewChatChars

  if (!hasEnoughNewMaterial) {
    return {
      deferred: true,
      dueAt: getNextAutonomousTreeholeDueAt(),
      reason: "自上次树洞后还没有足够的新相处素材",
      payload: {
        ...(task.payload || {}),
        treehole_generation_attempted: false,
        treehole_prefilter_reason: "insufficient_new_material",
        treehole_new_user_message_count: context.newUserMessageCount,
        treehole_new_user_chars: context.newUserChars,
        treehole_new_chat_chars: context.newChatChars,
        treehole_prefilter_checked_at: new Date().toISOString(),
      },
    }
  }

  const result = await generateAndSaveTreeholeUpdates(task.user_id, "autonomous", context)
  return {
    ...result,
    payload: {
      ...(task.payload || {}),
      ...(result.payload || {}),
      treehole_prefilter_reason: "sufficient_new_material",
      treehole_new_user_message_count: context.newUserMessageCount,
      treehole_new_user_chars: context.newUserChars,
      treehole_new_chat_chars: context.newChatChars,
    },
  }
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

  const attemptIndex = getInactivityAttemptIndex(task)
  if (attemptIndex > getInactivityAttemptLimit(reachOutMode)) {
    return { allowed: false, reason: "当前主动联系频率不允许继续本次沉默阶段" }
  }
  if (
    attemptIndex > 1
    && (!payload.continuation_of_task_id || !payload.silence_root_user_message_id)
  ) {
    return { allowed: false, reason: "连续主动联系缺少沉默阶段来源" }
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

async function getCurrentInactivityReachOutMode(userId) {
  const { data, error } = await supabase
    .from("user_state")
    .select("inactivity_reach_out_mode")
    .eq("user_id", userId)
    .maybeSingle()
  if (error && error.code !== "42703") throw error
  return error?.code === "42703"
    ? DEFAULT_INACTIVITY_REACH_OUT_MODE
    : normalizeInactivityReachOutMode(data?.inactivity_reach_out_mode)
}

async function enqueueNextInactivityReachOutTask({
  task,
  messageId,
  conversationId,
}) {
  const mode = await getCurrentInactivityReachOutMode(task.user_id)
  if (!canContinueInactivityChain(task, mode)) return null

  const currentAttempt = getInactivityAttemptIndex(task)
  const nextAttempt = currentAttempt + 1
  const delayMinutes = getNextInactivityDelayMinutes(nextAttempt)
  if (!delayMinutes) return null

  const scheduledAt = new Date().toISOString()
  const rawDueAt = new Date(Date.now() + delayMinutes * 60 * 1000)
  const dueAt = isProactiveQuietHours(rawDueAt)
    ? getNextProactiveMorning(rawDueAt)
    : rawDueAt.toISOString()
  const previousMessageIds = Array.from(new Set([
    ...(task.payload?.previous_proactive_message_ids || []).map(String),
    String(messageId),
  ]))
  const rootUserMessageId = String(
    task.payload?.silence_root_user_message_id
    || task.payload?.user_message_id
    || task.source_id
    || ""
  )
  if (!rootUserMessageId) return null

  const { data, error } = await supabase
    .from("xiaoc_proactive_tasks")
    .upsert({
      user_id: task.user_id,
      type: "inactivity_reach_out",
      source_type: "proactive_message",
      source_id: String(messageId),
      status: "pending",
      due_at: dueAt,
      conversation_id: conversationId || task.conversation_id,
      reason: "同一段沉默仍在继续，小C稍后重新判断是否自然靠近。",
      payload: {
        ...(task.payload || {}),
        scheduled_at: scheduledAt,
        reach_out_mode: mode,
        attempt_index: nextAttempt,
        silence_root_user_message_id: rootUserMessageId,
        user_message_id: rootUserMessageId,
        continuation_of_task_id: task.id,
        previous_proactive_message_ids: previousMessageIds,
      },
      completed_at: null,
      message_id: null,
      last_error: null,
      updated_at: scheduledAt,
    }, { onConflict: "user_id,type,source_type,source_id" })
    .select("id,due_at,status,payload")
    .single()
  if (error) throw error
  return data
}

async function consumePendingInactivityWithProactiveMessage({
  ownerTask,
  messageId,
  conversationId,
  skipReason,
}) {
  const { data: pending, error } = await supabase
    .from("xiaoc_proactive_tasks")
    .select("id,user_id,conversation_id,type,source_type,source_id,status,due_at,payload,created_at")
    .eq("user_id", ownerTask.user_id)
    .eq("type", "inactivity_reach_out")
    .eq("status", "pending")
    .order("due_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!pending) return null

  const previouslyCountedMessageIds = Array.isArray(pending.payload?.previous_proactive_message_ids)
    ? pending.payload.previous_proactive_message_ids.map(String)
    : []
  if (previouslyCountedMessageIds.includes(String(messageId))) return null

  const consumedAt = new Date().toISOString()
  const { data: consumed, error: consumeError } = await supabase
    .from("xiaoc_proactive_tasks")
    .update({
      status: "skipped",
      last_error: skipReason,
      updated_at: consumedAt,
    })
    .eq("id", pending.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle()
  if (consumeError) throw consumeError
  if (!consumed) return null

  return enqueueNextInactivityReachOutTask({
    task: pending,
    messageId,
    conversationId,
  })
}

async function consumePendingInactivityWithEventMessage({
  eventTask,
  messageId,
  conversationId,
}) {
  return consumePendingInactivityWithProactiveMessage({
    ownerTask: eventTask,
    messageId,
    conversationId,
    skipReason: "本轮由现实事件主动回访完成联系，避免同一时段重复发送",
  })
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
  if (task.id) {
    const { data: existingMessage, error: existingError } = await supabase
      .from("messages")
      .select("id,conversation_id")
      .eq("user_id", user_id)
      .eq("role", "assistant")
      .eq("metadata->>proactiveTaskId", String(task.id))
      .limit(1)
      .maybeSingle()

    if (existingError) throw existingError
    if (existingMessage?.id) {
      await supabase
        .from("user_state")
        .upsert({
          user_id,
          last_conversation_id: existingMessage.conversation_id || conversation_id,
          last_conversation: existingMessage.conversation_id || conversation_id,
          updated_at: new Date().toISOString(),
        })
      return String(existingMessage.id)
    }
  }

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

  let pushDiagnostics = {
    attempted: false,
    delivered_to_expo: false,
    reason: "push_not_configured",
  }
  try {
    const { data: pushState, error: pushStateError } = await supabase
      .from("user_state")
      .select("push_token,push_notifications_enabled,push_preview_enabled")
      .eq("user_id", user_id)
      .maybeSingle()

    if (pushStateError?.code === "42703") {
      pushDiagnostics = { ...pushDiagnostics, reason: "push_schema_missing" }
    } else if (pushStateError) {
      throw pushStateError
    } else if (!pushState?.push_notifications_enabled || !pushState?.push_token) {
      pushDiagnostics = { ...pushDiagnostics, reason: "push_disabled_or_unregistered" }
    } else {
      pushDiagnostics = await sendExpoPushMessage(
        buildProactivePushMessage({
          token: pushState.push_token,
          content,
          previewEnabled: pushState.push_preview_enabled !== false,
          data: {
            conversationId: conversation_id,
            messageId: String(message.id),
            proactiveType: task.type,
          },
        }),
        { accessToken: process.env.EXPO_ACCESS_TOKEN || "" },
      )
    }
  } catch (error) {
    pushDiagnostics = {
      attempted: true,
      delivered_to_expo: false,
      reason: "push_diagnostics_failed",
      error: trimText(error?.message, 240),
    }
  }

  const { data: storedMessage } = await supabase
    .from("messages")
    .select("metadata")
    .eq("id", message.id)
    .maybeSingle()
  await supabase
    .from("messages")
    .update({
      metadata: {
        ...(storedMessage?.metadata || {}),
        pushNotification: {
          ...pushDiagnostics,
          evaluated_at: new Date().toISOString(),
        },
      },
    })
    .eq("id", message.id)

  console.log("PROACTIVE PUSH NOTIFICATION:", {
    message_id: message.id,
    proactive_type: task.type,
    ...pushDiagnostics,
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
    if (candidate) {
      return {
        candidate,
        candidates,
        snapshot_message_id: message.id,
        snapshot_metadata: message.metadata || {},
      }
    }
  }
  return null
}

const PROACTIVE_RECONCILIATION_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000
const PROACTIVE_RECONCILIATION_SNAPSHOT_LIMIT = 120

async function reconcileExistingProactiveAttentionWakeups({
  userId = APP_USER.defaultUserId,
  now = new Date().toISOString(),
} = {}) {
  const cutoff = new Date(
    new Date(now).getTime() - PROACTIVE_RECONCILIATION_LOOKBACK_MS
  ).toISOString()
  const { data: messages, error: messagesError } = await supabase
    .from("messages")
    .select("id,conversation_id,metadata,created_at")
    .eq("user_id", userId)
    .eq("role", "assistant")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PROACTIVE_RECONCILIATION_SNAPSHOT_LIMIT)
  if (messagesError) throw messagesError

  const latestSnapshots = new Map()
  for (const message of messages || []) {
    if (latestSnapshots.has(message.conversation_id)) continue
    if (!Array.isArray(message.metadata?.proactiveAttentionCandidates)) continue
    latestSnapshots.set(message.conversation_id, message)
  }

  const candidates = []
  for (const [conversationId, message] of latestSnapshots) {
    for (const candidate of normalizeProactiveAttentionCandidates(
      message.metadata.proactiveAttentionCandidates
    )) {
      candidates.push({ candidate, conversationId, snapshotMessageId: message.id })
    }
  }
  if (!candidates.length) {
    return { scanned_snapshots: latestSnapshots.size, candidates: 0, created: 0, rescheduled: 0, unchanged: 0, rejected: 0 }
  }

  const eventIds = [...new Set(candidates.map(item => item.candidate.event_id).filter(Boolean))]
  const sourceIds = [...new Set(candidates
    .map(item => item.candidate.last_user_update?.message_id)
    .filter(Boolean)
    .map(String))]
  const [{ data: tasks, error: tasksError }, { data: sources, error: sourcesError }] = await Promise.all([
    supabase
      .from("xiaoc_proactive_tasks")
      .select("id,source_id,status,due_at,completed_at,updated_at,payload")
      .eq("user_id", userId)
      .eq("type", PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE)
      .eq("source_type", PROACTIVE_ATTENTION_WAKEUP_SOURCE_TYPE)
      .in("source_id", eventIds),
    sourceIds.length
      ? supabase
          .from("messages")
          .select("id,conversation_id,role")
          .eq("user_id", userId)
          .eq("role", "user")
          .in("id", sourceIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (tasksError) throw tasksError
  if (sourcesError) throw sourcesError

  const tasksByEvent = new Map((tasks || []).map(task => [String(task.source_id), task]))
  const validSources = new Set((sources || []).map(source => (
    `${source.conversation_id}\u001f${source.id}`
  )))
  const result = {
    scanned_snapshots: latestSnapshots.size,
    candidates: candidates.length,
    created: 0,
    rescheduled: 0,
    unchanged: 0,
    rejected: 0,
    reasons: {},
  }

  for (const item of candidates) {
    const candidate = item.candidate
    const existingTask = tasksByEvent.get(String(candidate.event_id)) || null
    const sourceMessageValid = validSources.has(
      `${item.conversationId}\u001f${candidate.last_user_update?.message_id}`
    )
    const plan = planExistingCandidateWakeupReconciliation({
      candidate,
      existingTask,
      sourceMessageValid,
      now,
    })

    result.reasons[plan.reason] = (result.reasons[plan.reason] || 0) + 1
    if (plan.action === "none") {
      if (
        existingTask?.status === "pending"
        && !["existing_pending_task", "existing_processing_task", "existing_completed_task"].includes(plan.reason)
      ) {
        const { error } = await supabase
          .from("xiaoc_proactive_tasks")
          .update({ status: "skipped", last_error: plan.reason, updated_at: now })
          .eq("id", existingTask.id)
          .eq("status", "pending")
        if (error) throw error
      }
      if (["existing_pending_task", "existing_processing_task", "existing_completed_task"].includes(plan.reason)) {
        result.unchanged += 1
      } else {
        result.rejected += 1
      }
      continue
    }

    const taskRecord = {
      user_id: userId,
      type: PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE,
      source_type: PROACTIVE_ATTENTION_WAKEUP_SOURCE_TYPE,
      source_id: candidate.event_id,
      status: "pending",
      due_at: plan.scheduled_for,
      conversation_id: item.conversationId,
      reason: "恢复既存候选事件缺失的 Proactive Attention wake-up。",
      payload: {
        execution_mode: "shadow",
        event_id: candidate.event_id,
        candidate_updated_at: candidate.updated_at,
        scheduled_for: plan.scheduled_for,
        reconciled_from_snapshot_message_id: item.snapshotMessageId,
        reconciled_at: now,
      },
      completed_at: null,
      message_id: null,
      last_error: null,
      updated_at: now,
    }
    const { data, error } = await supabase
      .from("xiaoc_proactive_tasks")
      .upsert(taskRecord, { onConflict: "user_id,type,source_type,source_id" })
      .select("id,source_id,status,due_at,payload")
      .single()
    if (error) throw error
    tasksByEvent.set(String(candidate.event_id), data)
    if (plan.action === "reschedule") result.rescheduled += 1
    else result.created += 1
  }

  return result
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
    requestPurpose: "proactive_event_generation",
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
  const rollout = evaluateLimitedProactiveAttentionRollout({
    candidate,
    execution,
    snapshotMetadata: latest.snapshot_metadata,
    now: evaluatedAt,
  })
  const sendDiagnostics = initialProactiveAttentionSendDiagnostics({
    eventId: candidate.event_id,
    taskId: task.id,
    execution,
    sendEnabled,
    rollout,
  })
  const basePayload = {
    ...(task.payload || {}),
    reload_snapshot_message_id: latest.snapshot_message_id,
    execution_context: context,
    execution,
  }

  if (
    execution.would_send
    && rollout.rollout_rejection_reason === "too_early_for_follow_up"
    && rollout.next_evaluation_at
  ) {
    return {
      deferred: true,
      dueAt: rollout.next_evaluation_at,
      reason: "too_early_for_follow_up",
      payload: {
        ...basePayload,
        proactiveAttentionSend: sendDiagnostics,
        rollout,
        no_op_reason: "too_early_for_follow_up",
      },
    }
  }

  // Production remains Shadow unless the explicit server-side flag is exactly true.
  // Keep this branch before context loading, generation, or message persistence.
  if (!sendEnabled || !execution.would_send || !rollout.rollout_eligible) {
    return {
      shadowOnly: true,
      conversationId: task.conversation_id,
      payload: {
        ...basePayload,
        proactiveAttentionSend: sendDiagnostics,
        rollout,
        no_op_reason: !execution.would_send
          ? execution.execution_reason
          : !rollout.rollout_eligible
            ? rollout.rollout_rejection_reason
            : "send_disabled",
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
      last_proactive_mention_updated: true,
      inactivity_ownership_outcome: "proactive_event_send_consumed",
    }
    await finalizeProactiveAttentionMessageMetadata({
      message: existingMessage,
      task,
      latest,
      diagnostics: recoveredDiagnostics,
      sentAt: existingMessage.created_at || evaluatedAt,
    })
    await consumePendingInactivityWithEventMessage({
      eventTask: task,
      messageId: existingMessage.id,
      conversationId: existingMessage.conversation_id || task.conversation_id,
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
  const finalRollout = evaluateLimitedProactiveAttentionRollout({
    candidate: finalLatest?.candidate || null,
    execution: finalExecution,
    snapshotMetadata: finalLatest?.snapshot_metadata || null,
    now: finalAt,
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
    rollout_eligible: finalRollout.rollout_eligible,
    rollout_rejection_reason: finalRollout.rollout_rejection_reason,
    rollout_evaluated_at: finalRollout.evaluated_at,
  }
  if (!finalRecheck.passed || !finalRollout.rollout_eligible) {
    const rejectionReason = finalRecheck.passed
      ? finalRollout.rollout_rejection_reason
      : finalRecheck.reason
    return {
      shadowOnly: true,
      conversationId: task.conversation_id,
      payload: {
        ...basePayload,
        final_execution_context: finalContext,
        final_execution: finalExecution,
        final_rollout: finalRollout,
        proactiveAttentionSend: checkedDiagnostics,
        no_op_reason: rejectionReason,
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
    last_proactive_mention_updated: true,
    inactivity_ownership_outcome: "proactive_event_send_consumed",
  }
  try {
    await finalizeProactiveAttentionMessageMetadata({
      message: { id: messageId },
      task,
      latest: finalLatest,
      diagnostics: completedDiagnostics,
      sentAt,
    })
    await consumePendingInactivityWithEventMessage({
      eventTask: task,
      messageId,
      conversationId: task.conversation_id,
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
  if (!["plan_follow_up", "inactivity_reach_out", "treehole_autonomous_update", WEATHER_SHADOW_TASK_TYPE, PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE].includes(task.type)) {
    return { skipped: true, reason: "unsupported proactive task type" }
  }

  if (task.type === PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE) {
    return executeProactiveAttentionWakeup(task)
  }

  if (task.type === "treehole_autonomous_update") {
    return executeAutonomousTreeholeUpdate(task)
  }

  if (task.type === WEATHER_SHADOW_TASK_TYPE) {
    return executeWeatherShadowCheck(task)
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

  const generation = task.type === "plan_follow_up"
    ? {
        content: await generatePlanFollowUpMessage({
          user_id: task.user_id,
          task,
        }),
        diagnostics: null,
      }
    : await generateInactivityReachOutMessage({
        user_id: task.user_id,
        task,
        recentContext,
      })
  const content = generation.content
  if (task.type === "inactivity_reach_out" && generation.skipped) {
    return {
      skipped: true,
      reason: generation.diagnostics?.skip_reason || "inactivity_generation_declined",
      payload: {
        ...(task.payload || {}),
        inactivity_generation: generation.diagnostics,
      },
    }
  }
  const conversationId = await getLastConversationId(task.user_id)
  const messageId = await saveProactiveMessage({
    user_id: task.user_id,
    conversation_id: conversationId,
    content,
    task,
    metadata: generation.diagnostics
      ? { inactivityGeneration: generation.diagnostics }
      : {},
  })
  const nextInactivityTask = task.type === "inactivity_reach_out"
    ? await enqueueNextInactivityReachOutTask({
        task,
        messageId,
        conversationId,
      })
    : null

  return {
    messageId,
    conversationId,
    content,
    ...(generation.diagnostics ? {
      payload: {
        ...(task.payload || {}),
        inactivity_generation: generation.diagnostics,
        continuation_task_id: nextInactivityTask?.id || null,
        continuation_due_at: nextInactivityTask?.due_at || null,
      },
    } : {}),
  }
}

async function checkPendingProactiveTasks() {
  const now = new Date()
  const staleBefore = new Date(now.getTime() - BACKGROUND_PROCESSING_STALE_MS).toISOString()
  const { data: staleTasks, error: staleTaskError } = await supabase
    .from("xiaoc_proactive_tasks")
    .select("id,type,payload,updated_at")
    .eq("status", "processing")
    .lte("updated_at", staleBefore)

  if (staleTaskError && staleTaskError.code !== "42P01") throw staleTaskError
  for (const staleTask of staleTasks || []) {
    const recovery = planBackgroundFailure({
      type: staleTask.type,
      previousAttempts: getPayloadRetryCount(staleTask.payload),
    })
    await supabase
      .from("xiaoc_proactive_tasks")
      .update({
        status: recovery.status,
        due_at: now.toISOString(),
        last_error: "stale processing claim recovered",
        payload: {
          ...(staleTask.payload || {}),
          background_retry_count: recovery.attemptCount,
          background_retry_limit: recovery.retryLimit,
          background_last_failure: "stale_processing_claim",
        },
        updated_at: now.toISOString(),
      })
      .eq("id", staleTask.id)
      .eq("status", "processing")
  }

  await Promise.all([
    ensureAutonomousTreeholeTask(APP_USER.defaultUserId),
    ensureWeatherShadowTasks(APP_USER.defaultUserId, now),
  ])
  let reconciliation
  try {
    reconciliation = await reconcileExistingProactiveAttentionWakeups({
      userId: APP_USER.defaultUserId,
      now: now.toISOString(),
    })
  } catch (error) {
    console.error("proactive attention reconciliation failed:", error)
    reconciliation = {
      failed: true,
      error: trimText(error?.message || "reconciliation failed", 180),
    }
  }

  const { data: pending, error } = await supabase
    .from("xiaoc_proactive_tasks")
    .select("id,user_id,conversation_id,type,source_type,source_id,status,due_at,reason,payload,created_at")
    .eq("status", "pending")
    .lte("due_at", now.toISOString())
    .order("due_at", { ascending: true })
    .limit(10)

  if (error && error.code === "42P01") {
    return { checked: 0, completed: 0, deferred: 0, failed: 0, missingTable: true }
  }

  if (error) throw error
  if (!pending?.length) return { checked: 0, completed: 0, deferred: 0, failed: 0, reconciliation }

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
      return { checked: pending.length, completed: 0, deferred: quietDeferred.length, failed: 0, nextDueAt, reconciliation }
    }
  }

  let completed = 0
  let deferred = isProactiveQuietHours(now) ? quietDeferred.length : 0
  let failed = 0

  const taskPriority = {
    proactive_attention_wakeup: 0,
    plan_follow_up: 1,
    weather_shadow_check: 2,
    inactivity_reach_out: 3,
    treehole_autonomous_update: 4,
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
            ...(result.payload ? { payload: result.payload } : {}),
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

    } catch (taskError) {
      failed += 1
      console.error("xiaoc proactive task failed:", taskError)
      const isEmptyTreeholeGeneration = task.type === "treehole_autonomous_update" &&
        taskError.message === "treehole_generation_returned_no_visible_draft"
      const failurePlan = planBackgroundFailure({
        type: task.type,
        previousAttempts: getPayloadRetryCount(task.payload),
      })
      await supabase
        .from("xiaoc_proactive_tasks")
        .update({
          status: isEmptyTreeholeGeneration
            ? "skipped"
            : failurePlan.status,
          due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          last_error: taskError.message || "proactive task failed",
          ...(!isEmptyTreeholeGeneration ? {
            payload: {
              ...(task.payload || {}),
              background_retry_count: failurePlan.attemptCount,
              background_retry_limit: failurePlan.retryLimit,
              background_last_failure: trimText(taskError.message, 240),
              ...(task.type === PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE ? {
                proactive_attention_send_attempt_count: failurePlan.attemptCount,
                proactive_attention_send_last_error: trimText(taskError.message, 240),
              } : {}),
              ...(taskError.proactiveAttentionSendDiagnostics ? {
                proactiveAttentionSend: taskError.proactiveAttentionSendDiagnostics,
              } : {}),
            },
          } : isEmptyTreeholeGeneration ? {
            payload: {
              ...(task.payload || {}),
              treehole_generation_attempted: true,
              treehole_generation_result: "invalid_or_empty_output",
              treehole_generation_at: new Date().toISOString(),
              treehole_generation_retry_suppressed: true,
            },
          } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id)
        .eq("status", "processing")
    }
  }

  return { checked: pending.length, completed, deferred, failed, reconciliation }
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
  const stalePerspectivePattern = /(刚刚|这会儿|此刻|现在才|刚结束|刚回到|今晚正在|待会儿|等会儿|一会儿|明天)/

  if (requiresDelayedVoice) {
    if (candidate.share_mode !== "delayed") {
      return { valid: false, reason: "过去事件被标记为即时记录" }
    }

    if (stalePerspectivePattern.test(candidate.text || "")) {
      return { valid: false, reason: "延迟分享仍使用事件发生时的相对时态" }
    }
  }

  if (candidate.share_mode === "immediate" && stalePerspectivePattern.test(candidate.text || "") && ageMs > 90 * 60 * 1000) {
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
  const staleBefore = new Date(now.getTime() - BACKGROUND_PROCESSING_STALE_MS).toISOString()
  const { data: staleCandidates, error: staleCandidateError } = await supabase
    .from("moment_candidates")
    .select("id,last_error,updated_at")
    .eq("status", "processing")
    .lte("updated_at", staleBefore)

  if (staleCandidateError?.code !== "42P01" && staleCandidateError) throw staleCandidateError
  for (const staleCandidate of staleCandidates || []) {
    const recovery = planBackgroundFailure({
      type: "moment_candidate",
      previousAttempts: getMarkedRetryCount(staleCandidate.last_error),
    })
    await supabase
      .from("moment_candidates")
      .update({
        status: recovery.status,
        publish_after: nowIso,
        last_error: withRetryMarker("stale processing claim recovered", recovery.attemptCount),
        updated_at: nowIso,
      })
      .eq("id", staleCandidate.id)
      .eq("status", "processing")
  }

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
      await sendContentUpdateNotification(candidate.user_id, "moments_update")
      published += 1
      break
    } catch (candidateError) {
      failed += 1
      console.error("moment candidate publish failed:", candidateError)
      const failurePlan = planBackgroundFailure({
        type: "moment_candidate",
        previousAttempts: getMarkedRetryCount(candidate.last_error),
      })
      await supabase
        .from("moment_candidates")
        .update({
          status: failurePlan.status,
          publish_after: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          last_error: withRetryMarker(
            candidateError.message || "candidate publish failed",
            failurePlan.attemptCount,
          ),
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
  const staleBefore = new Date(now.getTime() - BACKGROUND_PROCESSING_STALE_MS).toISOString()
  const { data: staleActivities, error: staleActivityError } = await supabase
    .from("moment_xiaoc_activity")
    .select("id,decision_reason,updated_at")
    .eq("status", "processing")
    .lte("updated_at", staleBefore)

  if (staleActivityError) throw staleActivityError
  for (const staleActivity of staleActivities || []) {
    const recovery = planBackgroundFailure({
      type: "moment_xiaoc_activity",
      previousAttempts: getMarkedRetryCount(staleActivity.decision_reason),
    })
    await supabase
      .from("moment_xiaoc_activity")
      .update({
        status: recovery.status,
        next_check_at: now.toISOString(),
        decision_reason: withRetryMarker(
          stripRetryMarker(staleActivity.decision_reason) || "stale processing claim recovered",
          recovery.attemptCount,
        ),
        updated_at: now.toISOString(),
      })
      .eq("id", staleActivity.id)
      .eq("status", "processing")
  }

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
    let resolvedReason = stripRetryMarker(activity.decision_reason)
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
      const failurePlan = planBackgroundFailure({
        type: "moment_xiaoc_activity",
        previousAttempts: getMarkedRetryCount(activity.decision_reason),
      })
      await supabase
        .from("moment_xiaoc_activity")
        .update({
          status: failurePlan.status,
          next_check_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          decision: resolvedDecision,
          decision_reason: withRetryMarker(
            resolvedDecision ? resolvedReason : "判断失败，等待有限重试",
            failurePlan.attemptCount,
          ),
          updated_at: new Date().toISOString(),
        })
        .eq("id", activity.id)
        .eq("status", "processing")
    }
  }

  return { checked: pending.length, completed, deferred: 0, failed }
}

async function flushSharedContextForConversation({ userId, conversationId, sharedContext }) {
  const pendingResult = await loadPendingSharedContextMessages({
    supabase,
    userId,
    conversationId,
    workingContext: sharedContext.working_context,
    boundAt: sharedContext.bound_at,
  })
  if (pendingResult.reason === "checkpoint_missing") {
    return { triggered: false, reason: "checkpoint_missing", llmCalled: false }
  }
  const pending = pendingResult.messages
  const trigger = shouldUpdateSharedContext(pending, { force: true })
  if (!trigger.shouldUpdate) return { triggered: false, reason: trigger.reason, llmCalled: false }

  const raw = await callSmallLLM([
    { role: "user", content: buildSharedContextUpdatePrompt(sharedContext, pending) },
  ], {
    requestPurpose: "shared_context_batch_update_forced",
    model: AI_MODELS.memoryJudge,
    max_tokens: 900,
    temperature: 0,
    response_format: { type: "json_object" },
  })
  const workingContext = parseSharedContextUpdate(
    raw,
    sharedContext.working_context,
    pending,
    conversationId
  )
  if (!workingContext) {
    return { triggered: true, reason: "parse_failed", llmCalled: true }
  }
  const { error: updateError } = await supabase
    .from("shared_contexts")
    .update({ working_context: workingContext, updated_at: new Date().toISOString() })
    .eq("id", sharedContext.id)
    .eq("user_id", userId)
  if (updateError) throw updateError
  return {
    triggered: true,
    reason: trigger.reason,
    llmCalled: true,
    sourceMessageCount: workingContext.source_message_ids.length,
  }
}

async function ensureSharedContextConversation(userId, conversationId) {
  const { data, error } = await supabase
    .from("conversations")
    .select("conversation_id")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .maybeSingle()
  if (error) throw error
  if (data?.conversation_id) return
  const { error: insertError } = await supabase
    .from("conversations")
    .insert({ user_id: userId, conversation_id: conversationId, title: "新对话" })
  if (insertError) throw insertError
}

async function handleSharedContextRequest(req, res, userId) {
  const action = req.method === "GET" ? req.query.action || "list" : req.body.action
  const conversationId = req.method === "GET"
    ? req.query.conversation_id
    : req.body.conversation_id

  if (req.method === "GET" && action === "list") {
    const { data, error } = await supabase
      .from("shared_contexts")
      .select("id,title,kind,status,working_context,created_at,updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(50)
    if (error) throw error
    return res.status(200).json((data || []).map(normalizeSharedContext).filter(Boolean))
  }

  if (req.method === "GET" && action === "current") {
    if (!conversationId) return res.status(400).json({ error: "conversation_id required" })
    const { data, error } = await supabase
      .from("conversations")
      .select("shared_context_bound_at,shared_context:shared_contexts(id,title,kind,status,working_context,created_at,updated_at)")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .maybeSingle()
    if (error) throw error
    return res.status(200).json({ shared_context: normalizeSharedContext(data?.shared_context) })
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Unsupported method" })

  if (action === "create") {
    const title = trimText(req.body.title, 120)
    const kind = ["reading", "article", "project", "discussion", "other"]
      .includes(req.body.kind) ? req.body.kind : "other"
    if (!title) return res.status(400).json({ error: "title required" })
    const { data, error } = await supabase
      .from("shared_contexts")
      .insert({ user_id: userId, title, kind, working_context: emptySharedWorkingContext() })
      .select("id,title,kind,status,working_context,created_at,updated_at")
      .single()
    if (error) throw error
    const context = normalizeSharedContext(data)
    if (conversationId) {
      await ensureSharedContextConversation(userId, conversationId)
      const { error: bindError } = await supabase
        .from("conversations")
        .update({ shared_context_id: context.id, shared_context_bound_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("conversation_id", conversationId)
      if (bindError) throw bindError
    }
    return res.status(200).json({ shared_context: context, bound: Boolean(conversationId) })
  }

  if (action === "bind") {
    if (!conversationId || !req.body.shared_context_id) {
      return res.status(400).json({ error: "conversation_id and shared_context_id required" })
    }
    await ensureSharedContextConversation(userId, conversationId)
    const { data: contextData, error: contextError } = await supabase
      .from("shared_contexts")
      .select("id,title,kind,status,working_context,created_at,updated_at")
      .eq("id", req.body.shared_context_id)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle()
    if (contextError) throw contextError
    const context = normalizeSharedContext(contextData)
    if (!context) return res.status(404).json({ error: "Shared Context not found" })
    const { data: priorBindings, error: priorBindingsError } = await supabase
      .from("conversations")
      .select("conversation_id,shared_context_bound_at")
      .eq("user_id", userId)
      .eq("shared_context_id", context.id)
      .neq("conversation_id", conversationId)
      .order("shared_context_bound_at", { ascending: false })
      .limit(5)
    if (priorBindingsError) throw priorBindingsError
    for (const binding of priorBindings || []) {
      const { data: latestContextData, error: latestContextError } = await supabase
        .from("shared_contexts")
        .select("id,title,kind,status,working_context,created_at,updated_at")
        .eq("id", context.id)
        .eq("user_id", userId)
        .single()
      if (latestContextError) throw latestContextError
      await flushSharedContextForConversation({
        userId,
        conversationId: binding.conversation_id,
        sharedContext: {
          ...normalizeSharedContext(latestContextData),
          bound_at: binding.shared_context_bound_at || null,
        },
      })
    }
    const { data: refreshedContextData, error: refreshError } = await supabase
      .from("shared_contexts")
      .select("id,title,kind,status,working_context,created_at,updated_at")
      .eq("id", context.id)
      .eq("user_id", userId)
      .single()
    if (refreshError) throw refreshError
    const refreshedContext = normalizeSharedContext(refreshedContextData)
    const { error } = await supabase
      .from("conversations")
      .update({ shared_context_id: refreshedContext.id, shared_context_bound_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
    if (error) throw error
    return res.status(200).json({ shared_context: refreshedContext, bound: true })
  }

  if (action === "unbind") {
    if (!conversationId) return res.status(400).json({ error: "conversation_id required" })
    const { data, error } = await supabase
      .from("conversations")
      .select("shared_context_bound_at,shared_context:shared_contexts(id,title,kind,status,working_context,created_at,updated_at)")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .maybeSingle()
    if (error) throw error
    const normalizedContext = normalizeSharedContext(data?.shared_context)
    const context = normalizedContext
      ? { ...normalizedContext, bound_at: data?.shared_context_bound_at || null }
      : null
    const update = context
      ? await flushSharedContextForConversation({ userId, conversationId, sharedContext: context })
      : { triggered: false, reason: "not_bound", llmCalled: false }
    const { error: unbindError } = await supabase
      .from("conversations")
      .update({ shared_context_id: null, shared_context_bound_at: null })
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
    if (unbindError) throw unbindError
    return res.status(200).json({ shared_context: null, bound: false, update })
  }

  if (action === "archive") {
    if (!req.body.shared_context_id) return res.status(400).json({ error: "shared_context_id required" })
    const { error } = await supabase
      .from("shared_contexts")
      .update({ status: "archived", updated_at: new Date().toISOString() })
      .eq("id", req.body.shared_context_id)
      .eq("user_id", userId)
    if (error) throw error
    await supabase.from("conversations")
      .update({ shared_context_id: null, shared_context_bound_at: null })
      .eq("user_id", userId)
      .eq("shared_context_id", req.body.shared_context_id)
    return res.status(200).json({ archived: true })
  }

  return res.status(405).json({ error: "Unsupported action" })
}

export default async function handler(req, res) {
  if (!requirePrivateAppRequest(req, res)) return
  try {

    const user_id =
      req.method === "GET"
        ? req.query.user_id || APP_USER.defaultUserId
        : req.body.user_id || APP_USER.defaultUserId

    const type =
      req.method === "GET"
        ? req.query.type
        : req.body.type

    if (type === "shared_context") {
      return handleSharedContextRequest(req, res, user_id)
    }

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

      console.log("MOMENT XIAOC CHECK COMPLETED")
      return res.status(200).json({ success: true, ...result })
    }

    if (req.method === "GET" && type === "moment_interaction_check") {
      const authorization = String(req.headers.authorization || "")

      if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" })
      }

      const result = await checkPendingMomentsForXiaoC()

      console.log("MOMENT INTERACTION EVENT CHECK COMPLETED")
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

      console.log("XIAOC BACKGROUND CHECK COMPLETED")
      return res.status(200).json({ success: true, ...result })
    }

    if (req.method === "GET" && type === "xiaoc_proactive_check") {
      const authorization = String(req.headers.authorization || "")

      if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" })
      }

      const result = await checkPendingProactiveTasks()

      console.log("XIAOC PROACTIVE CHECK COMPLETED")
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
        if (req.body.action === "generate_for_date") {
          const targetDate = String(req.body.target_date || "").trim()
          let window
          try {
            window = getDiaryDateContextWindow(targetDate, new Date(), DIARY_TIMEZONE)
          } catch (error) {
            return res.status(400).json({ error: error.message })
          }

          const formatted = formatDiaryDate(targetDate)
          const { data: existingEntries, error: existingError } = await supabase
            .from("diary_entries")
            .select("id,created_at")
            .eq("user_id", user_id)
            .eq("date", formatted.date)
            .order("created_at", { ascending: false })
            .limit(1)
          if (existingError) throw existingError

          const existingEntry = existingEntries?.[0] || null
          if (existingEntry && req.body.replace_existing !== true) {
            return res.status(409).json({
              error: "这一天已经有一页日记",
              existing_id: existingEntry.id,
            })
          }

          const context = await getManualDiaryContext(user_id, window)
          if (!context.messageCount || !context.text.trim()) {
            return res.status(422).json({ error: "这一天还没有足够的真实对话可以写进日记" })
          }

          const raw = await callSmallLLM([
            { role: "user", content: buildManualDiaryPrompt(targetDate, window, context.text) },
          ], {
            requestPurpose: "diary_manual_generation",
            model: AI_MODELS.chat,
            max_tokens: 2600,
            temperature: 0.55,
            response_format: MANUAL_DIARY_RESPONSE_FORMAT,
            provider: { require_parameters: true },
          })
          const draft = parseManualDiaryDraft(raw)
          if (!draft) {
            return res.status(502).json({ error: "这页日记没有写完整，旧内容没有改变" })
          }

          const now = new Date()
          const entryId = existingEntry?.id || `diary_${targetDate}`
          const entry = {
            id: entryId,
            date: formatted.date,
            displayDate: formatted.displayDate,
            title: draft.title,
            writtenAt: `写于 ${now.toLocaleString("zh-CN", {
              timeZone: DIARY_TIMEZONE,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }).replaceAll("/", ".")}`,
            recorder: "记录者：小C",
            footnote: draft.footnote || undefined,
            sections: draft.sections,
          }
          const storedFields = {
            date: entry.date,
            display_date: entry.displayDate,
            title: entry.title,
            written_at: entry.writtenAt,
            recorder: entry.recorder,
            footnote: entry.footnote || null,
            sections: entry.sections,
          }

          const writeResult = existingEntry
            ? await supabase
                .from("diary_entries")
                .update(storedFields)
                .eq("user_id", user_id)
                .eq("id", existingEntry.id)
                .select("id")
                .single()
            : await supabase
                .from("diary_entries")
                .insert({ id: entryId, user_id, ...storedFields })
                .select("id")
                .single()
          if (writeResult.error) throw writeResult.error

          return res.status(200).json({
            success: true,
            replaced: Boolean(existingEntry),
            context_message_count: context.messageCount,
            entry,
          })
        }

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
        const xiaocSeenMomentIds = new Set()

        if (momentIds.length > 0) {
          const [commentsResult, activitiesResult] = await Promise.all([
            supabase
              .from("moment_comments")
              .select("moment_id")
              .eq("user_id", user_id)
              .in("moment_id", momentIds),
            supabase
              .from("moment_xiaoc_activity")
              .select("moment_id,seen_at,liked_at")
              .eq("user_id", user_id)
              .in("moment_id", momentIds)
              .not("seen_at", "is", null),
          ])

          const { data: comments, error: commentsError } = commentsResult
          const { data: xiaocActivities, error: xiaocActivitiesError } = activitiesResult

          if (commentsError && commentsError.code !== "42P01") {
            return res.status(500).json({
              error: commentsError.message
            })
          }

          if (xiaocActivitiesError && xiaocActivitiesError.code !== "42P01") {
            return res.status(500).json({
              error: xiaocActivitiesError.message
            })
          }

          for (const comment of comments || []) {
            commentCounts[comment.moment_id] = (commentCounts[comment.moment_id] || 0) + 1
          }

          for (const activity of xiaocActivities || []) {
            xiaocSeenMomentIds.add(activity.moment_id)
            if (activity.liked_at) xiaocLikedMomentIds.add(activity.moment_id)
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
            xiaocSeen: xiaocSeenMomentIds.has(item.id),
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

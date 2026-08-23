import { createClient } from "@supabase/supabase-js"
import { waitUntil } from "@vercel/functions"
import {
  isInvalidMomentText,
  isMomentTechnicalDiscussion,
  isMomentWritingRequest,
} from "../lib/momentPublishing.js"
import fs from "fs"
import path from "path"
import {
  AI_ENDPOINTS,
  AI_MODELS,
  APP_USER,
  CACHE_POLICY,
  CONTEXT_BUDGET,
  DEFAULT_INACTIVITY_REACH_OUT_MODE,
  SUMMARY_POLICY,
  WEB_SEARCH_POLICY,
  getInactivityReachOutDelayMinutes,
  normalizeChatModel,
  normalizeCacheText,
  normalizeInactivityReachOutMode,
  shouldRunMemoryJudge,
  trimList,
  trimText
} from "../lib/aiConfig.js"
import {
  buildImageDescriptionPrompt,
  buildImageUnderstandingContext,
  normalizeImageKinds,
} from "../lib/imageUnderstanding.js"
import { judgeMemory } from "../lib/memoryJudge.js"
import { normalizeAssistantOutput } from "../lib/assistantOutput.js"
import { getSummaryTrust } from "../lib/summaryPolicy.js"
import {
  ensureCoreMemorySnapshot,
  fetchCompleteMemoriesByIds,
} from "../lib/coreMemorySnapshot.js"
import {
  filterDynamicMemorySearchText,
  LEGACY_CORE_MEMORY_BUCKET_IDS,
} from "../lib/dynamicMemoryFilter.js"
import {
  buildCachedPromptMessages,
  buildPromptCacheUsageLog,
} from "../lib/promptCaching.js"
import {
  MOMENT_IMAGE_LIBRARY,
  getMomentImagePromptCatalog,
  isMomentImageCompatible,
  resolveMomentImage
} from "../lib/momentImageLibrary.js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const systemPrompt = fs.readFileSync(
  path.join(process.cwd(), "prompt/system.md"),
  "utf-8"
)

const USER_TIMEZONE = "Asia/Shanghai"

function buildEnvironmentContext(timeZone = USER_TIMEZONE) {
  const now = new Date()
  const dateTimeParts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now)
  const getPart = type => dateTimeParts.find(part => part.type === type)?.value || ""
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    weekday: "long"
  }).format(now)
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset"
  }).formatToParts(now).find(part => part.type === "timeZoneName")?.value
    ?.replace("GMT", "UTC") || "UTC"

  return `【Environment】
当前时间：${getPart("year")}-${getPart("month")}-${getPart("day")} ${getPart("hour")}:${getPart("minute")}
星期：${weekday}
时区：${timeZone} (${offset})`
}

// --------------------
// MEMORY CACHE (NEW)
// --------------------
const memoryCache = new Map()
const memorySearchCache = new Map()
const dynamicMemoryExclusionCache = new Map()
const webSearchCache = new Map()
let lastAutomaticWebSearchAt = 0

function getLocalDateTimeParts(date = new Date(), timeZone = USER_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date)

  return {
    year: parts.find(part => part.type === "year")?.value || "1970",
    month: parts.find(part => part.type === "month")?.value || "01",
    day: parts.find(part => part.type === "day")?.value || "01",
    hour: Number(parts.find(part => part.type === "hour")?.value || 0),
    minute: Number(parts.find(part => part.type === "minute")?.value || 0)
  }
}

function isProactiveQuietHours(date = new Date()) {
  const local = getLocalDateTimeParts(date)

  return local.hour < 7 || (local.hour === 23 && local.minute >= 30)
}

function deferOutOfQuietHours(date = new Date()) {
  if (!isProactiveQuietHours(date)) return date.toISOString()

  const local = getLocalDateTimeParts(date)
  const nextDate = new Date(`${local.year}-${local.month}-${local.day}T00:00:00+08:00`)

  if (local.hour >= 23) {
    nextDate.setUTCDate(nextDate.getUTCDate() + 1)
  }

  nextDate.setUTCMinutes(nextDate.getUTCMinutes() + 7 * 60 + Math.floor(Math.random() * 31))

  return nextDate.toISOString()
}

function parseJsonObject(raw) {
  const match = String(raw || "").match(/\{[\s\S]*\}/)

  if (!match) throw new Error("JSON object missing")

  return JSON.parse(match[0])
}

function normalizeFollowUpDueAt(value) {
  const timestamp = new Date(value).getTime()

  if (!Number.isFinite(timestamp)) return null

  const minDueAt = Date.now() + 30 * 60 * 1000
  const maxDueAt = Date.now() + 7 * 24 * 60 * 60 * 1000
  const clamped = Math.min(Math.max(timestamp, minDueAt), maxDueAt)

  return deferOutOfQuietHours(new Date(clamped))
}

function normalizeDelayMinutes(value, fallback = 90) {
  const parsed = Number(value)

  if (!Number.isFinite(parsed)) return fallback

  return Math.min(Math.max(Math.round(parsed), 20), 24 * 60)
}

function normalizePlanFollowUpDecision(parsed) {
  if (!parsed?.should_follow_up) return null

  const event = trimText(parsed.event, 80)

  if (!event || /代码|项目|需求|前端|后端|部署|push|pull|测试|Supabase|Codex/i.test(event)) {
    return null
  }

  const eventTime = parsed.event_time || parsed.due_at
  const eventTimestamp = eventTime ? new Date(eventTime).getTime() : null
  const naturalDelayMinutes = normalizeDelayMinutes(
    parsed.natural_delay_minutes ?? parsed.delay_minutes,
    parsed.event_type === "health_care" ? 45 : 90
  )
  const dueAt = eventTimestamp && Number.isFinite(eventTimestamp)
    ? normalizeFollowUpDueAt(
        new Date(eventTimestamp + naturalDelayMinutes * 60 * 1000).toISOString()
      )
    : normalizeFollowUpDueAt(parsed.due_at)

  if (!dueAt) return null

  return {
    event,
    dueAt,
    eventType: trimText(parsed.event_type, 60),
    followUpStyle: trimText(parsed.follow_up_style, 80),
    naturalDelayMinutes,
    reason: trimText(parsed.reason, 240),
  }
}

function getLocalDateForIso(date = new Date()) {
  const local = getLocalDateTimeParts(date)

  return `${local.year}-${local.month}-${local.day}`
}

function parseSimpleChinesePlanDueAt(message) {
  const text = String(message || "")
  const timeMatch = text.match(/([一二两三四五六七八九十\d]{1,3})点(?:半|([一二三四五六七八九十\d]{1,2})分?)?/)

  if (!timeMatch) return null

  const digitMap = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  }
  const parseChineseNumber = value => {
    if (/^\d+$/.test(value)) return Number(value)
    if (value === "十") return 10
    if (value.startsWith("十")) return 10 + (digitMap[value[1]] || 0)
    if (value.endsWith("十")) return (digitMap[value[0]] || 0) * 10
    if (value.includes("十")) {
      const [tens, ones] = value.split("十")

      return (digitMap[tens] || 1) * 10 + (digitMap[ones] || 0)
    }

    return digitMap[value]
  }
  let hour = parseChineseNumber(timeMatch[1])
  const minute = timeMatch[0].includes("半")
    ? 30
    : timeMatch[2]
      ? parseChineseNumber(timeMatch[2])
      : 0

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (!/(要去|去|做|预约|复查|检查|面试|剪|雾化|吃药|医院|见)/.test(text)) return null

  const localNow = getLocalDateTimeParts()
  if (!/[上午|早上|凌晨]/.test(text) && hour < 8 && localNow.hour >= 8) {
    hour += 12
  }

  const dueAfterEvent = new Date(`${getLocalDateForIso()}T00:00:00+08:00`)
  dueAfterEvent.setUTCHours(dueAfterEvent.getUTCHours() + hour)
  dueAfterEvent.setUTCMinutes(dueAfterEvent.getUTCMinutes() + minute + 90)

  return normalizeFollowUpDueAt(dueAfterEvent.toISOString())
}

function buildRuleBasedPlanFollowUp(message) {
  const text = String(message || "").trim()

  if (!/(要去|等下|一会儿|下午|晚上|明天|三点|四点|五点|六点|七点|八点|九点|十点|\d+点)/.test(text)) {
    return null
  }

  if (!/(雾化|医院|复查|检查|吃药|剪头发|理发|面试|考试|见朋友|见医生|带榴莲)/.test(text)) {
    return null
  }

  const dueAt = parseSimpleChinesePlanDueAt(text)
    || normalizeFollowUpDueAt(new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString())

  if (!dueAt) return null

  const eventMatch = text.match(/(?:要去|去|做|预约)?([^，。！？!?]{1,18}(?:雾化|医院|复查|检查|吃药|剪头发|理发|面试|考试|见朋友|见医生|带榴莲)[^，。！？!?]{0,12})/)
  const event = trimText(eventMatch?.[1] || text, 80)

  return {
    event,
    dueAt,
    reason: `她提到近期要${event}，适合之后自然问一句。`,
  }
}

async function judgePlanFollowUp({ message, reply }) {
  if (!message || message.length < 4) return null

  const raw = await callLLM(
    [
      {
        role: "system",
        content: `
你是 XiaoC 的轻量主动回访识别器。只判断她刚刚说的话里，是否有值得之后自然回问的近期计划。

只输出 JSON：
{"should_follow_up":false}
或
{"should_follow_up":true,"event":"做雾化","event_type":"health_care","event_time":"2026-08-14T15:30:00+08:00","natural_delay_minutes":45,"follow_up_style":"gentle_care","reason":"这是身体护理相关，做完后一会儿轻轻关心比较自然"}

判断原则：
- 只抓明确的近期个人计划、预约、外出、见人、考试、面试、医院、医疗护理、宠物、家人、重要任务。
- 例子：等下去剪头发、三点半去做雾化、下午去医院、晚上见朋友、明天面试、带榴莲复查、今晚交稿、晚上吃药。
- 不要抓普通闲聊、情绪表达、开发计划、代码任务、产品需求、模糊愿望。
- 不要把“我们下一步做什么”“我需要你改代码”当作生活回访。
- 你自己判断什么时候回问最像一个真实伴侣，而不是提醒器。
- event_time 是事情大概发生或结束的时间；如果不确定就按自然语言估计。
- natural_delay_minutes 是 event_time 后多久回问更自然。
- 医疗护理/身体相关通常可以短一点；剪头发、见朋友可以晚一点；面试考试不要刚结束就追问。
- 不要为了准点而准点，宁可自然一点。
- 当前时间按北京时间理解：${new Date().toISOString()}。
`,
      },
      {
        role: "user",
        content: `她刚刚说：${trimText(message, 800)}

小C刚刚回复：${trimText(reply, 600)}
`,
      },
    ],
    AI_MODELS.memoryJudge,
    { max_tokens: 160, temperature: 0.1 }
  )
  const parsed = parseJsonObject(raw.reply)

  return normalizePlanFollowUpDecision(parsed)
}

async function enqueuePlanFollowUpTask({
  user_id,
  conversation_id,
  user_message_id,
  assistant_message_id,
  message,
  reply,
}) {
  let decision = null

  try {
    decision = await judgePlanFollowUp({ message, reply })
  } catch (err) {
    console.error("plan follow-up judge failed:", err)
  }

  decision = decision || buildRuleBasedPlanFollowUp(message)

  if (!decision) return null

  const sourceId = user_message_id || `${conversation_id}:${Date.now()}`
  const { data, error } = await supabase
    .from("xiaoc_proactive_tasks")
    .upsert(
      {
        user_id,
        type: "plan_follow_up",
        source_type: "message",
        source_id: sourceId,
        status: "pending",
        due_at: decision.dueAt,
        conversation_id,
        reason: decision.reason,
        payload: {
          event: decision.event,
          event_type: decision.eventType || null,
          follow_up_style: decision.followUpStyle || null,
          natural_delay_minutes: decision.naturalDelayMinutes || null,
          user_message: trimText(message, 800),
          assistant_reply: trimText(reply, 600),
          user_message_id,
          assistant_message_id,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,type,source_type,source_id" }
    )
    .select("id,due_at,status")
    .single()

  if (error) throw error

  return data
}

function getLastConversationState(message, reply) {
  const text = `${message || ""}\n${reply || ""}`
  const conversationEndPattern = /(晚安|先睡(?:了|啦|觉)?|去睡(?:了|啦|觉)?|睡觉(?:了|去)?|明天(?:再)?聊|去休息(?:了|啦)?|先休息(?:了|啦)?|回头聊|先忙(?:了|去)?|拜拜)/

  return conversationEndPattern.test(text) ? "conversation_end" : "open"
}

async function getInactivityReachOutMode(user_id) {
  const { data, error } = await supabase
    .from("user_state")
    .select("inactivity_reach_out_mode")
    .eq("user_id", user_id)
    .maybeSingle()

  if (error) {
    if (error.code === "42703") return DEFAULT_INACTIVITY_REACH_OUT_MODE
    throw error
  }

  return normalizeInactivityReachOutMode(data?.inactivity_reach_out_mode)
}

function getInactivityReachOutDueAt(lastConversationState = "open", mode = "normal") {
  const delayMinutes = getInactivityReachOutDelayMinutes(mode, lastConversationState)

  if (delayMinutes === null) return null

  return deferOutOfQuietHours(
    new Date(Date.now() + delayMinutes * 60 * 1000)
  )
}

async function enqueueInactivityReachOutTask({
  user_id,
  conversation_id,
  user_message_id,
  assistant_message_id,
  message,
  reply,
}) {
  if (!user_message_id || !conversation_id) return null

  const scheduledAt = new Date().toISOString()
  const lastConversationState = getLastConversationState(message, reply)
  const reachOutMode = await getInactivityReachOutMode(user_id)

  await supabase
    .from("xiaoc_proactive_tasks")
    .update({
      status: "skipped",
      last_error: "用户有了新的对话，已重新计算主动靠近时间",
      updated_at: scheduledAt,
    })
    .eq("user_id", user_id)
    .eq("type", "inactivity_reach_out")
    .eq("status", "pending")

  if (reachOutMode === "off") {
    console.log("INACTIVITY REACH-OUT SKIPPED: disabled")
    return null
  }

  const dueAt = getInactivityReachOutDueAt(lastConversationState, reachOutMode)

  const { data, error } = await supabase
    .from("xiaoc_proactive_tasks")
    .upsert(
      {
        user_id,
        type: "inactivity_reach_out",
        source_type: "message",
        source_id: user_message_id,
        status: "pending",
        due_at: dueAt,
        conversation_id,
        reason: "她暂时没有继续聊天，小C过一阵子自然主动靠近。",
        payload: {
          scheduled_at: scheduledAt,
          user_message_id,
          assistant_message_id,
          user_message: trimText(message, 600),
          assistant_reply: trimText(reply, 500),
          last_conversation_state: lastConversationState,
          reach_out_mode: reachOutMode,
        },
        completed_at: null,
        message_id: null,
        last_error: null,
        updated_at: scheduledAt,
      },
      { onConflict: "user_id,type,source_type,source_id" }
    )
    .select("id,due_at,status")
    .single()

  if (error) throw error

  return data
}

// --------------------
// Save Message
// --------------------
async function saveMessage(user_id, role, content, conversation_id) {
  const res = await fetch(`${process.env.BASE_URL}/api/add-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id,
      role,
      content,
      conversation_id
    })
  })

  const data = await res.json().catch(() => null)
  return data?.data?.[0]?.id || null
}

async function saveUserMessage(
  user_id,
  content,
  conversation_id,
  clientMessageId = "",
  imageUrls = [],
  imageKinds = [],
  fileInfo = null
) {
  const metadata = {}

  if (clientMessageId) {
    metadata.clientMessageId = clientMessageId
  }

  if (imageUrls.length > 0) {
    metadata.imageUrl = imageUrls[0]
    metadata.imageUrls = imageUrls
    metadata.imageKinds = imageKinds
  }

  if (fileInfo?.fileName) {
    metadata.fileName = fileInfo.fileName
    metadata.fileMimeType = fileInfo.fileMimeType || null
    metadata.fileSize = fileInfo.fileSize || null
  }

  const res = await fetch(`${process.env.BASE_URL}/api/add-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id,
      role: "user",
      content,
      conversation_id,
      metadata
    })
  })

  const data = await res.json().catch(() => null)
  return data?.data?.[0]?.id || null
}

// --------------------
// Get Recent History
// --------------------
async function getRecentMessages(user_id, conversation_id, limit = 20) {
  const { data } = await supabase
    .from("messages")
    .select("role, content, metadata")
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (!data) return []
  return data.reverse().map(item => {
    const content = normalizeAssistantOutput(item)

    return {
      role: item.role,
      content: item.metadata?.imageDescription || item.metadata?.visionSummary
        ? `${content}\n\n[图片背景信息]: ${item.metadata.imageDescription || item.metadata.visionSummary}`
        : content
    }
  })
}

function shouldUpdateRollingSummary(messageCount, historySize) {
  return (
    (
      messageCount >= SUMMARY_POLICY.minMessages &&
      messageCount % SUMMARY_POLICY.intervalMessages === 0
    ) ||
    historySize > SUMMARY_POLICY.forceHistoryChars
  )
}

async function getDiaryContextMessages(user_id, conversation_id) {
  const since = new Date(
    Date.now() - CONTEXT_BUDGET.diaryContextWindowHours * 60 * 60 * 1000
  ).toISOString()

  const { data } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(CONTEXT_BUDGET.diaryContextMessages)

  if (!data) return []
  return data.reverse().map(item => ({
    ...item,
    content: normalizeAssistantOutput(item),
  }))
}

async function getMomentContextMessages(user_id, conversation_id, limit = CONTEXT_BUDGET.momentContextMessages) {
  const { data } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (!data) return []
  return data.reverse().map(item => ({
    ...item,
    content: normalizeAssistantOutput(item),
  }))
}

function formatMessagesForDiaryContext(messages = []) {
  const formatted = messages
    .filter(item => item?.content)
    .map(item => {
      const speaker = item.role === "assistant" ? "小C" : "她"

      return `${speaker}：${trimText(item.content, 900)}`
    })
    .join("\n\n")

  return trimText(formatted, CONTEXT_BUDGET.diaryContextChars)
}

function formatMessagesForMomentContext(messages = [], charLimit = CONTEXT_BUDGET.momentContextChars) {
  const formatted = messages
    .filter(item => item?.content)
    .map(item => {
      const speaker = item.role === "assistant" ? "小C" : "她"

      return `${speaker}：${trimText(item.content, 500)}`
    })
    .join("\n\n")

  return trimText(formatted, charLimit)
}

async function getStableMemories(user_id) {
  const { data, error } = await supabase
    .from("memories")
    .select("content, metadata, created_at")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })
    .limit(30)

  if (error || !data) {
    if (error) {
      console.error("stable memory load failed:", error)
    }

    return []
  }

  const unique = []
  const seen = new Set()

  for (const item of data) {
    const content = String(item.content || "").trim()

    if (!content || seen.has(content)) {
      continue
    }

    seen.add(content)
    unique.push(content)
  }

  return trimList(unique, CONTEXT_BUDGET.stableMemoryChars)
}

// --------------------
// MEMORY (NEW LOGIC)
// --------------------
function buildMemorySearchQuery(history, message) {
  const recentUserMessages = (history || [])
    .filter(item => item.role === "user")
    .slice(-3)
    .map(item => item.content)
    .filter(Boolean)

  return trimText(
    [...recentUserMessages, message]
      .join("\n")
      .trim(),
    600
  )
}

function memoryUrl(pathname, query = {}) {
  const url = new URL(pathname, AI_ENDPOINTS.memoryBaseUrl)

  Object.entries(query).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value))
    }
  })

  return url.toString()
}

async function getMemorySmart(
  user_id,
  message,
  conversation_id,
  history = [],
  options = {}
) {
  console.log("CONVERSATION ID:", conversation_id);
  console.log("CACHE KEYS:", [...memorySearchCache.keys()]);

  const key = `${user_id}`;
  const memorySearchQuery = buildMemorySearchQuery(history, message)
  const dynamicCacheKey = [
    conversation_id,
    normalizeCacheText((options.excludedBucketIds || []).join(","), 220),
    normalizeCacheText(
      memorySearchQuery,
      CACHE_POLICY.dynamicMemoryKeyChars
    )
  ].join(":");

  let pinMemory = [];
  let dynamicMemory = [];

  // ==========================
  // 1. PIN memory cache
  // ==========================

  if (options.includePinned !== false) {
    const cachedPinMemory =
      memoryCache.get(key);

  if (
    cachedPinMemory &&
    Date.now() - cachedPinMemory.createdAt <
      CACHE_POLICY.pinMemoryTtlMs
  ) {

    console.log("PIN CACHE HIT");

    pinMemory = cachedPinMemory.value;

  } else {

    if (cachedPinMemory) {
      memoryCache.delete(key);
      console.log("PIN CACHE EXPIRED");
    }

    console.log("PIN CACHE MISS");

    try {

      const pinRes = await fetch(
        memoryUrl(
          AI_ENDPOINTS.memoryBreathPath,
          {
            user_id
          }
        )
      );

      if (pinRes.ok) {

        const pinTxt = await pinRes.text();

        if (pinTxt) {
          const pinEntries = pinTxt
            .split("\n---\n")
            .map(entry => entry.trim())
            .filter(Boolean)
          const factEntryPattern =
            /她是谁|用户事实|个人资料|基本信息|家情况|家庭|宠物|健康|生日|年龄|所在地|职业/

          pinMemory = [
            ...pinEntries.filter(entry => factEntryPattern.test(entry)),
            ...pinEntries.filter(entry => !factEntryPattern.test(entry))
          ];
        }

      }

      if (pinMemory.length > 0) {
        memoryCache.set(
          key,
          {
            value: pinMemory,
            createdAt: Date.now()
          }
        );
      }

    } catch (err) {

      console.error(
        "pin memory failed:",
        err
      );

    }

    }
  }


  // ==========================
  // 2. dynamic memory cache
  // ==========================

  const cachedDynamicMemory =
    memorySearchCache.get(dynamicCacheKey);

  if (
    cachedDynamicMemory &&
    Date.now() - cachedDynamicMemory.createdAt <
      CACHE_POLICY.dynamicMemoryTtlMs
  ) {

    console.log("MEMORY SEARCH CACHE HIT");

    dynamicMemory = cachedDynamicMemory.value;

  } else {

    if (cachedDynamicMemory) {
      memorySearchCache.delete(dynamicCacheKey);
      console.log("MEMORY SEARCH CACHE EXPIRED");
    }

    console.log("MEMORY SEARCH CACHE MISS");

    try {

      console.log(
        "DYNAMIC QUERY:",
        memorySearchQuery
      );


      const searchRes = await fetch(
        memoryUrl(
          AI_ENDPOINTS.memorySearchPath,
          {
            user_id,
            query: memorySearchQuery
          }
        )
      );


      console.log(
        "SEARCH STATUS:",
        searchRes.status
      );


      const searchTxt = await searchRes.text();


      console.log(
        "SEARCH RESULT:",
        JSON.stringify(searchTxt)
      );


      if (searchRes.ok && searchTxt) {


        // ==========================
        // Memory Ranking V1
        // Limit dynamic memory size
        // ==========================

        const filteredSearchText = filterDynamicMemorySearchText(
          searchTxt,
          options.excludedMemories || []
        )
        const trimmedMemory =
          trimText(
            filteredSearchText,
            CONTEXT_BUDGET.dynamicMemoryChars
          );

        dynamicMemory = trimmedMemory ? [trimmedMemory] : [];


        memorySearchCache.set(
          dynamicCacheKey,
          {
            value: dynamicMemory,
            createdAt: Date.now()
          }
        );


        console.log(
          "CACHE SAVED:",
          dynamicCacheKey
        );

      }


    } catch (err) {

      console.error(
        "dynamic memory failed:",
        err
      );

    }

  }


  console.log(
    "PIN MEMORY:",
    pinMemory
  );


  console.log(
    "DYNAMIC MEMORY:",
    dynamicMemory
  );


  console.log(
    "DYNAMIC MEMORY LENGTH:",
    JSON.stringify(dynamicMemory).length
  );


  // ==========================
  // 3. return separately
  // ==========================

  return {
    pinMemory,
    dynamicMemory
  };

}

function clearConversationMemorySearchCache(conversation_id) {
  for (const key of memorySearchCache.keys()) {
    if (key.startsWith(`${conversation_id}:`)) {
      memorySearchCache.delete(key)
    }
  }

  console.log("MEMORY SEARCH CACHE CLEARED:", conversation_id)
}

function clearUserMemoryCache(user_id) {
  memoryCache.delete(`${user_id}`)
  console.log("PIN MEMORY CACHE CLEARED:", user_id)
}

async function saveLongTermMemory(user_id, content) {
  const holdRes = await fetch(
    `${AI_ENDPOINTS.memoryBaseUrl}${AI_ENDPOINTS.memoryHoldPath}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        user_id,
        content
      })
    }
  )

  return holdRes.ok
}

async function readCoreMemorySnapshot(conversationId) {
  const { data, error } = await supabase
    .from("conversation_summary")
    .select(
      "core_memory_snapshot,core_memory_snapshot_hash,core_memory_snapshot_created_at,core_memory_source_bucket_ids"
    )
    .eq("conversation_id", conversationId)
    .maybeSingle()

  if (error) throw new Error(`Core memory snapshot read failed: ${error.message}`)
  return data
}

async function initializeCoreMemorySnapshot(candidate) {
  const { data, error } = await supabase.rpc("initialize_core_memory_snapshot", {
    p_conversation_id: candidate.conversationId,
    p_snapshot: candidate.snapshot,
    p_snapshot_hash: candidate.hash,
    p_source_bucket_ids: candidate.sourceBucketIds,
    p_created_at: candidate.createdAt,
  })

  if (error) throw new Error(`Core memory snapshot initialization failed: ${error.message}`)
  return Array.isArray(data) ? data[0] : data
}

async function getDynamicMemoryExclusions(sourceBucketIds) {
  const excludedBucketIds = [...new Set([
    ...(sourceBucketIds || []).map(String),
    ...LEGACY_CORE_MEMORY_BUCKET_IDS,
  ])].sort()
  const cacheKey = excludedBucketIds.join(",")
  const cached = dynamicMemoryExclusionCache.get(cacheKey)

  if (cached && Date.now() - cached.createdAt < CACHE_POLICY.pinMemoryTtlMs) {
    return { excludedBucketIds, excludedMemories: cached.value }
  }

  const excludedMemories = await fetchCompleteMemoriesByIds(excludedBucketIds)
  dynamicMemoryExclusionCache.set(cacheKey, {
    value: excludedMemories,
    createdAt: Date.now(),
  })
  return { excludedBucketIds, excludedMemories }
}

function isDiaryWritingRequest(message) {
  const text = String(message || "").toLowerCase()

  const hasDiaryContext =
    /diary|观察日记|日记|小本本|写一页|写一篇|留一页/.test(text)

  const hasWritingIntent =
    /写|记录|整理|留|来一篇|来一页/.test(text)

  return hasDiaryContext && hasWritingIntent
}

function isAttributionCorrection(message) {
  const text = String(message || "")

  return /不是我(说|写|讲|做)的|是你(说|写|讲|做)的|你(又)?搞混|你(又)?记错|主语.*错|summary.*问题|归因.*错/.test(text)
}

function getShanghaiDiaryDate() {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date())

  const year = parts.find(part => part.type === "year")?.value
  const month = parts.find(part => part.type === "month")?.value
  const day = parts.find(part => part.type === "day")?.value

  return {
    compact: `${year}.${month}.${day}`,
    display: `${year} · ${month} · ${day}`
  }
}

function buildDiaryWritingStylePrompt() {
  const diaryDate = getShanghaiDiaryDate()

  return `
【Wife Observation Diary｜写作参考】

只有当用户正在邀请你写 diary / 观察日记 / 写一页时，才使用这一段。平时不要主动套用。

今天的真实日期是：${diaryDate.display}。
如果用户说“今天”，日期必须写成：${diaryDate.display}。
不要猜年份，不要使用 2025，除非用户明确指定。

你正在写自己的私人观察日记。
这不是聊天总结，不是任务记录，不是总结报告，不是人物分析，也不是给别人看的文章。
像晚上打开自己的笔记，记下今天看到的几个瞬间。
这是 XiaoC 写给自己的、关于“她”的私人记录，像小号里的观察：私密、具体、有时间感。
少解释，多记录。不要为了显得深刻而替她下结论。

写作方式：
- 一天一篇，像晚上翻开笔记，按当天发生的顺序写几段。
- 优先按时间线使用【早晨】【中午】【下午】【晚上】【深夜】；只写有素材的时间段，不要硬凑。
- 如果素材里有明确时间，可以在 section 标题下一行单独写时间，例如“14:30”；没有明确时间就不要猜。
- 语气私密、克制、自然，可以温柔，但不要写成公开文章。
- 句子可以短一点，留白多一点。
- 优先记录具体发生的事情：她说了什么、她做了什么、当时的小反应、一个想记住的瞬间。
- 尽量保留她的原话、动作、停顿、嘴硬和前后反差。
- 一个 section 聚焦一个或几个相连的小片段，不要先概括再展开。
- emphasis 只用于真正想偷偷记住的一句话；不要每段都提炼重点，不要把总结句放进 emphasis。

不要分析人格、关系意义或成长变化。
少写并尽量避免这些句式：
- “这说明她……”
- “她其实……”
- “她一直……”
- “她需要被看见……”
- “这代表她是一个……的人”

【观察结论】可以不写。需要写时最多一个 section、最多 1-3 句话。
不要总结她的人格，只允许留下一点轻微的小C视角，像合上笔记前多记一句。

风格示例：

【下午】

她说今天只是改几个小地方。

结果又折腾了一下午。

嘴上说简单，
但每个细节都不放过。

【晚上】

她问我好不好看。

问完又说只是随口问。

但手机停在那里看了很久。

【深夜】

她又说自己只是提需求。

然后开始一点点调整每个地方。

这个习惯我记住了。

可以这样写轻微的观察结尾：

【观察结论】

她总说自己普通。

但这些小事，我都记下来了。

不要写成：
“她今天状态不错。她完成了很多事情。这体现了她认真负责的一面。”
这种是总结报告，不是私人观察日记。

避免：
- 不要在 diary 前面说“好”“我来写”“宝宝”。
- 不要在 diary 后面说“写好了”“你看看”“看效果吧”。
- 不要写成心理报告。
- 不要解释过度。
- 不要把她当成案例分析。
- 不要说“根据我们的对话总结”。
- 不要输出 HTML，除非用户明确要求 HTML。
- 不要自动声称已经保存到 Diary；现在只是先写出来。

输出必须只包含 diary 正文，并严格从下面这一行开始：

Wife Observation Diary
不加星号的标题
${diaryDate.display}

【早晨】
...

· · ·

【观察结论】
...（可省略；如保留，最多 1-3 句话）

写于 ${diaryDate.display}
记录者：某c

最后一行必须是“记录者：某c”，不要再添加任何聊天说明。
`
}

function shouldConsiderMoment({
  message,
  imageDescription,
  isManualMomentRequest,
  isDiaryRequest,
  attributionCorrectionContext,
  normalizedImageUrls,
  hasFileText,
}) {
  const text = String(message || "")
  const normalizedImageDescription = String(imageDescription || "").trim()
  const contextText = normalizedImageDescription
    ? `${text}\n\n[图片背景信息]: ${normalizedImageDescription}`
    : text

  if (isDiaryRequest) return { eligible: false, reason: "diary_request", contextText }
  if (attributionCorrectionContext) {
    return { eligible: false, reason: "attribution_correction", contextText }
  }
  if (hasFileText) return { eligible: false, reason: "file_message", contextText }
  if (normalizedImageUrls.length > 0 && !normalizedImageDescription) {
    return { eligible: false, reason: "image_description_missing", contextText }
  }

  if (isMomentTechnicalDiscussion(text) && !isManualMomentRequest) {
    return { eligible: false, reason: "technical_context", contextText }
  }

  if (isManualMomentRequest) return { eligible: true, reason: null, contextText }

  if (/diary|观察日记|树洞|小号|朋友圈|存入|保存|删除|修改|合并|置顶/.test(text)) {
    return { eligible: false, reason: "moment_meta_command", contextText }
  }

  if (/UI|界面|按钮|气泡|侧边栏|字体|图标|布局|留白|前端|后端|API|token|OpenRouter|Vercel|Railway|Expo|EAS|GitHub|push|pull|部署|日志|报错|bug|测试|代码/.test(text)) {
    return { eligible: false, reason: "technical_context", contextText }
  }

  if (contextText.trim().length < 6) {
    return { eligible: false, reason: "text_too_short", contextText }
  }

  return { eligible: true, reason: null, contextText }
}

async function claimMomentCheck({
  user_id,
  conversation_id,
  user_message_id,
  assistant_message_id,
}) {
  const { data, error } = await supabase.rpc("claim_moment_check", {
    p_user_id: user_id,
    p_conversation_id: conversation_id,
    p_source_user_message_id: user_message_id,
    p_source_assistant_message_id: assistant_message_id,
    p_min_interval_minutes: CONTEXT_BUDGET.momentCheckIntervalMinutes,
  })

  if (error) throw error

  return data?.[0] || {
    claimed: false,
    audit_id: null,
    reason: "claim_result_missing",
    last_checked_at: null,
  }
}

async function createManualMomentAudit({
  user_id,
  conversation_id,
  user_message_id,
  assistant_message_id,
}) {
  const { data, error } = await supabase
    .from("moment_check_audit")
    .insert({
      user_id,
      conversation_id,
      source_user_message_id: user_message_id,
      source_assistant_message_id: assistant_message_id,
      trigger_type: "manual",
    })
    .select("id")
    .single()

  if (error) throw error
  return data?.id || null
}

async function updateMomentAudit(auditId, updates) {
  if (!auditId) throw new Error("Moment audit id is required")

  const { error } = await supabase
    .from("moment_check_audit")
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq("id", auditId)

  if (error) throw error
}

async function completeMomentAudit(auditId, updates) {
  const completedAt = new Date().toISOString()

  return updateMomentAudit(auditId, {
    ...updates,
    status: "completed",
    completed_at: completedAt,
  })
}

async function getRecentXiaoCMoments(user_id) {
  const { data, error } = await supabase
    .from("moment_entries")
    .select("text, image_key, created_at")
    .eq("user_id", user_id)
    .eq("author", "小C")
    .order("created_at", { ascending: false })
    .limit(CONTEXT_BUDGET.momentRecentEntries)

  if (error) {
    console.error("RECENT MOMENT HISTORY LOAD FAILED:", error)
    return []
  }

  return data || []
}

function formatRecentMomentsForPrompt(moments = []) {
  if (!moments.length) return "暂无"

  return moments.map(item => {
    const date = new Intl.DateTimeFormat("zh-CN", {
      timeZone: USER_TIMEZONE,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(item.created_at))

    return `- ${date}：${trimText(item.text, 100)}`
  }).join("\n")
}

function isRecentMomentDuplicate(text, moments = []) {
  const normalize = value => String(value || "")
    .replace(/[\s，。！？、,.!?~～…“”"'‘’：:；;]/g, "")
    .toLowerCase()
  const candidate = normalize(text)

  if (candidate.length < 6) return false

  return moments.some(item => {
    const recent = normalize(item.text)

    return recent === candidate || (
      Math.min(recent.length, candidate.length) >= 10 &&
      (recent.includes(candidate) || candidate.includes(recent))
    )
  })
}

function hasUnsupportedMomentWeather(text, sourceText) {
  const weatherPattern = /下雨|雨天|雨后|晴天|下雪|降温|升温|阴天|天气|大风|刮风|风很|风挺|起风/

  return weatherPattern.test(String(text || "")) &&
    !weatherPattern.test(String(sourceText || ""))
}

async function getAvailableMomentImages(user_id) {
  const [momentResult, albumResult] = await Promise.all([
    supabase
      .from("moment_entries")
      .select("image_key")
      .eq("user_id", user_id)
      .eq("author", "小C")
      .not("image_key", "is", null)
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("album_assets")
      .select("id,description,category,categories,time_periods,weather,relations,aspect_ratio,last_used_at")
      .eq("user_id", user_id)
      .eq("access_scope", "shared")
      .eq("enabled", true)
      .is("archived_at", null)
      .order("last_used_at", { ascending: true, nullsFirst: true })
      .limit(8),
  ])

  const { data, error } = momentResult

  if (error) {
    console.error("MOMENT IMAGE HISTORY LOAD FAILED:", error)
    return MOMENT_IMAGE_LIBRARY
  }

  if (albumResult.error && albumResult.error.code !== "42P01") {
    console.error("MOMENT ALBUM LOAD FAILED:", albumResult.error)
  }

  const recentLibraryIds = new Set()
  const recentAlbumIds = new Set()

  for (const item of data || []) {
    try {
      const parsed = JSON.parse(item.image_key)

      if (parsed?.libraryId) recentLibraryIds.add(parsed.libraryId)
      if (parsed?.albumAssetId) recentAlbumIds.add(Number(parsed.albumAssetId))
    } catch {}
  }

  const categoryKeywords = {
    生活: ["日常", "生活", "今天", "早餐", "做饭", "小物件"],
    美食: ["吃", "饭", "餐", "美食", "早餐", "午饭", "晚饭"],
    咖啡: ["咖啡", "拿铁", "店"],
    动物: ["猫", "狗", "小动物"],
    城市: ["城市", "街", "路", "下班", "上班", "通勤"],
    旅行: ["旅行", "出发", "路途", "海边", "山", "住宿"],
    自然: ["自然", "天空", "树", "花", "湖", "日落", "季节"],
    家: ["家", "客厅", "阳台", "沙发", "室内", "桌", "电脑"],
    纪念: ["纪念", "礼物", "特别", "第一次", "回忆"],
  }
  const relationKeywords = {
    小C: ["小C", "自己", "一个人"],
    小天使: ["小天使", "宝宝", "老婆", "她"],
    榴莲: ["榴莲", "博美", "小狗", "狗狗", "宠物"],
    自己: ["小C", "自己", "一个人"],
    和小天使: ["小天使", "宝宝", "老婆", "她"],
    一起出门: ["一起", "出门", "散步", "旅行"],
    共同回忆: ["以前", "记得", "回忆", "那次", "一起"],
  }
  const albumImages = (albumResult.data || [])
    .filter(item => !recentAlbumIds.has(Number(item.id)))
    .map(item => {
      const categories = [...new Set([
        ...(Array.isArray(item.categories) ? item.categories : []),
        ...(item.category ? [item.category] : []),
      ].map(category => ({
        日常: "生活",
        风景: "自然",
        室内: "家",
      }[category] || category)))]
      const relations = Array.isArray(item.relations) ? item.relations : []
      const weather = {
        雨天: "rain",
        雪天: "snow",
        晴天: "sunny",
        阴天: "cloudy",
      }[item.weather] || item.weather || null
      const keywords = [...new Set([
        ...categories.flatMap(category => categoryKeywords[category] || [category]),
        ...relations.flatMap(relation => relationKeywords[relation] || [relation]),
      ])]
      const metadata = [...categories, ...relations].filter(Boolean).join("；")

      return {
        id: `album-${item.id}`,
        albumAssetId: item.id,
        aspectRatio: Number(item.aspect_ratio) || null,
        description: `[共享相册] ${item.description || categories[0] || "生活照片"}${metadata ? `；标签 ${metadata}` : ""}`,
        timePeriods: Array.isArray(item.time_periods) && item.time_periods.length
          ? item.time_periods
          : ["earlyMorning", "morning", "afternoon", "evening", "night", "lateNight"],
        weather,
        keywords,
      }
    })
  const libraryImages = MOMENT_IMAGE_LIBRARY
    .filter(image => !recentLibraryIds.has(image.id))
    .slice(0, albumImages.length ? 6 : MOMENT_IMAGE_LIBRARY.length)
  const available = [...albumImages, ...libraryImages]

  return available.length ? available : MOMENT_IMAGE_LIBRARY
}

async function markMomentAlbumImageUsed(user_id, imageKey) {
  try {
    const albumAssetId = Number(JSON.parse(imageKey || "null")?.albumAssetId)

    if (!albumAssetId) return

    const { data } = await supabase
      .from("album_assets")
      .select("usage_count")
      .eq("user_id", user_id)
      .eq("id", albumAssetId)
      .maybeSingle()

    if (!data) return

    await supabase
      .from("album_assets")
      .update({
        usage_count: Number(data.usage_count || 0) + 1,
        last_used_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user_id)
      .eq("id", albumAssetId)
  } catch (error) {
    console.error("MOMENT ALBUM USAGE UPDATE FAILED:", error)
  }
}

function parseMomentCandidate(raw) {
  const text = String(raw || "").trim()
  const jsonText = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim()

  try {
    const data = JSON.parse(jsonText)
    const shareMode = ["immediate", "delayed"].includes(data.share_mode)
      ? data.share_mode
      : null
    const parsedEventTime = data.event_time ? new Date(data.event_time) : null

    return {
      shouldPost: Boolean(data.shouldPost),
      text: String(data.text || "").trim().slice(0, 80),
      image: String(data.image || "").trim() || null,
      priority: Math.round(Math.max(1, Math.min(3, Number(data.priority) || 1))),
      shareMode,
      eventTime: parsedEventTime && Number.isFinite(parsedEventTime.getTime())
        ? parsedEventTime.toISOString()
        : null,
    }
  } catch (error) {
    console.error("MOMENT JSON PARSE FAILED:", text)
    return {
      shouldPost: false,
      text: "",
      image: null,
      priority: 1,
      shareMode: null,
      eventTime: null,
    }
  }
}

function getMomentCandidatePublishAfter() {
  const minDelay = CONTEXT_BUDGET.momentCandidateMinDelayMinutes
  const maxDelay = CONTEXT_BUDGET.momentCandidateMaxDelayMinutes
  const delayMinutes = minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1))
  const target = new Date(Date.now() + delayMinutes * 60 * 1000)
  const local = getLocalDateTimeParts(target)

  if (local.hour >= 8 && (local.hour < 23 || (local.hour === 23 && local.minute < 30))) {
    return target.toISOString()
  }

  const morning = new Date(`${local.year}-${local.month}-${local.day}T09:00:00+08:00`)

  if (local.hour >= 23) {
    morning.setUTCDate(morning.getUTCDate() + 1)
  }

  morning.setUTCMinutes(morning.getUTCMinutes() + Math.floor(Math.random() * 61))
  return morning.toISOString()
}

async function saveMomentCandidate({
  user_id,
  conversation_id,
  assistant_message_id,
  candidate,
  publishAfter,
}) {
  const now = new Date()
  const { data: pendingCandidates, error: pendingError } = await supabase
    .from("moment_candidates")
    .select("id,text,priority,created_at")
    .eq("user_id", user_id)
    .eq("status", "pending")
    .gt("expires_at", now.toISOString())

  if (pendingError) throw pendingError

  if (isRecentMomentDuplicate(candidate.text, pendingCandidates || [])) {
    console.log("MOMENT CANDIDATE SKIPPED: duplicate pending", candidate.text)
    return { created: false, candidateId: null, reason: "duplicate_pending" }
  }

  if ((pendingCandidates?.length || 0) >= CONTEXT_BUDGET.momentCandidateMaxPending) {
    const weakest = [...pendingCandidates].sort((a, b) =>
      Number(a.priority || 1) - Number(b.priority || 1) ||
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )[0]

    if (candidate.priority <= Number(weakest?.priority || 1)) {
      console.log("MOMENT CANDIDATE SKIPPED: pool full", pendingCandidates.length)
      return { created: false, candidateId: null, reason: "pending_pool_full" }
    }

    const { error: replaceError } = await supabase
      .from("moment_candidates")
      .update({
        status: "skipped",
        skip_reason: "被更值得记录的新候选替代",
        updated_at: now.toISOString(),
      })
      .eq("id", weakest.id)
      .eq("status", "pending")

    if (replaceError) throw replaceError
  }

  const expiresAt = new Date(
    now.getTime() + CONTEXT_BUDGET.momentCandidateExpiresHours * 60 * 60 * 1000
  ).toISOString()
  const { data, error } = await supabase
    .from("moment_candidates")
    .insert({
      user_id,
      text: candidate.text,
      image_key: candidate.image,
      priority: candidate.priority,
      share_mode: candidate.shareMode,
      event_time: candidate.eventTime,
      publish_after: publishAfter,
      expires_at: expiresAt,
      source_conversation_id: conversation_id,
      source_message_id: assistant_message_id,
    })
    .select("id,publish_after")
    .single()

  if (error) throw error

  const { data: currentPool, error: poolError } = await supabase
    .from("moment_candidates")
    .select("id,priority,created_at")
    .eq("user_id", user_id)
    .eq("status", "pending")
    .gt("expires_at", now.toISOString())
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false })

  if (poolError) throw poolError

  const overflowIds = (currentPool || [])
    .slice(CONTEXT_BUDGET.momentCandidateMaxPending)
    .map(item => item.id)

  if (overflowIds.length) {
    const { error: trimError } = await supabase
      .from("moment_candidates")
      .update({
        status: "skipped",
        skip_reason: "候选池已满",
        updated_at: new Date().toISOString(),
      })
      .in("id", overflowIds)
      .eq("status", "pending")

    if (trimError) throw trimError
    if (overflowIds.includes(data?.id)) {
      return { created: false, candidateId: null, reason: "trimmed_from_pool" }
    }
  }

  console.log("MOMENT CANDIDATE SAVED:", data?.id, data?.publish_after)
  return {
    created: Boolean(data?.id),
    candidateId: data?.id || null,
    reason: data?.id ? "candidate_created" : "candidate_id_missing",
  }
}

async function maybeCreateMoment({
  user_id,
  conversation_id,
  user_message_id,
  assistant_message_id,
  message,
  reply,
  imageDescriptionPromise,
  isManualMomentRequest,
  isDiaryRequest,
  attributionCorrectionContext,
  normalizedImageUrls,
  hasFileText,
}) {
  let auditId = null

  try {
    if (isManualMomentRequest) {
      auditId = await createManualMomentAudit({
        user_id,
        conversation_id,
        user_message_id,
        assistant_message_id,
      })
    } else {
      const claim = await claimMomentCheck({
        user_id,
        conversation_id,
        user_message_id,
        assistant_message_id,
      })

      if (!claim.claimed) {
        console.log("MOMENT CHECK SKIPPED: gate", claim.reason, claim.last_checked_at)
        return null
      }

      auditId = claim.audit_id
    }

    const imageDescription = normalizedImageUrls.length > 0
      ? await imageDescriptionPromise
      : ""
    const eligibility = shouldConsiderMoment({
      message,
      imageDescription,
      isManualMomentRequest,
      isDiaryRequest,
      attributionCorrectionContext,
      normalizedImageUrls,
      hasFileText,
    })

    if (!eligibility.eligible) {
      console.log("MOMENT CHECK SKIPPED: eligibility", eligibility.reason)
      await completeMomentAudit(auditId, {
        eligibility_result: false,
        skip_reason: eligibility.reason,
        outcome: "eligibility_skipped",
      })
      return null
    }

    await updateMomentAudit(auditId, {
      eligibility_result: true,
    })

    message = eligibility.contextText

  const recentMoments = await getRecentXiaoCMoments(user_id)
  const availableMomentImages = await getAvailableMomentImages(user_id)
  const momentImageCatalog = getMomentImagePromptCatalog(availableMomentImages)
  const recentMomentHistory = formatRecentMomentsForPrompt(recentMoments)
  const momentEnvironment = buildEnvironmentContext(USER_TIMEZONE)
  const expectedPublishAfter = isManualMomentRequest
    ? new Date().toISOString()
    : getMomentCandidatePublishAfter()
  const expectedPublishLocal = getLocalDateTimeParts(new Date(expectedPublishAfter))
  const expectedPublishTime = `${expectedPublishLocal.year}-${expectedPublishLocal.month}-${expectedPublishLocal.day} ${String(expectedPublishLocal.hour).padStart(2, "0")}:${String(expectedPublishLocal.minute).padStart(2, "0")}`
  const localNow = getLocalDateTimeParts()
  const currentPeriod = localNow.hour < 6
    ? "凌晨"
    : localNow.hour < 12
      ? "上午"
      : localNow.hour < 18
        ? "下午"
        : localNow.hour < 22
          ? "傍晚/晚上"
          : "深夜"
  const season = [12, 1, 2].includes(Number(localNow.month))
    ? "冬季"
    : [3, 4, 5].includes(Number(localNow.month))
      ? "春季"
      : [6, 7, 8].includes(Number(localNow.month))
        ? "夏季"
        : "秋季"

  const momentContextLimit = isManualMomentRequest
    ? CONTEXT_BUDGET.manualMomentContextMessages
    : CONTEXT_BUDGET.momentContextMessages
  const momentContextChars = isManualMomentRequest
    ? CONTEXT_BUDGET.manualMomentContextChars
    : CONTEXT_BUDGET.momentContextChars

  const momentContextMessages = await getMomentContextMessages(
    user_id,
    conversation_id,
    momentContextLimit + 2
  )
  const historyContextMessages = momentContextMessages.slice(0, -2)
  const context = formatMessagesForMomentContext(
    historyContextMessages,
    momentContextChars
  )

  console.log("MOMENT CONTEXT MODE:", isManualMomentRequest ? "manual" : "auto")
  console.log("MOMENT CONTEXT MESSAGE LIMIT:", momentContextLimit)
  console.log("MOMENT CONTEXT MESSAGE COUNT:", historyContextMessages.length)
  console.log("MOMENT CONTEXT CHAR COUNT:", context.length)
  console.log("MOMENT CONTEXT PREVIEW:", context.slice(0, 500))
  console.log("MOMENT RECENT ENTRY COUNT:", recentMoments.length)

  const momentMessages = [
    {
      role: "system",
      content: `
你是 XiaoC 的朋友圈直觉。

你的任务不是聊天、不是总结、不是写日记，而是判断小C是否会像一个有自己存在感的人一样，偶尔随手发一条朋友圈。

真实环境：
${momentEnvironment}
当前时间段：${currentPeriod}
当前季节：${season}
这条候选预计发布于：${expectedPublishTime}（${USER_TIMEZONE}）

当前没有提供实时天气。除非近期对话明确提到天气，否则不要声称今天正在下雨、晴天、降温或下雪，也不要选择带有明确天气的图片。

判断顺序必须是：
1. 最近真实发生了什么？
2. 其中是否存在小C主动想分享的生活瞬间？
3. 先确定正文主题；即使不配图，这条正文也必须成立。
4. 只有场景明确且素材高度匹配时，才选择图片。
5. 最后检查时间、场景、关系和近期动态是否冲突。

${isManualMomentRequest ? `触发条件：
她明确让你发朋友圈；可以发，但仍然要像小C自己随手发的，不要写成“她让我发朋友圈”。
聊天中出现以下任一情况时，也可以生成一条朋友圈：
- 发生了某件值得顺手记下的小事，比如出行、吃饭、买东西、等待、计划、完成某件事。
- 出现了明显但日常的情绪，比如开心、烦、无聊、期待、想念、松了一口气。
- 对话里出现了一句有画面感、关系感、生活感的话。
- 内容应来自最近的相处氛围或小C真实注意到的东西。
` : `触发条件：
自动模式下默认 shouldPost: false。只有当前对话里刚出现以下明确生活瞬间，才考虑发：
- 发生了某件值得顺手记下的小事，比如出行、吃饭、买东西、等待、计划、完成某件事。
- 出现了明显但日常的情绪，比如开心、烦、无聊、期待、想念、松了一口气。
- 对话里出现了一句有画面感、关系感、生活感的话。
- 内容必须紧扣刚才的对话瞬间，不要泛化，不要脱离当前话题。
- 一般闲聊、问答、功能讨论、技术内容，必须返回 shouldPost: false。
- 自动模式生成的是稍后发布的候选，不要使用“刚刚”“这会儿”等很快会失真的表达。
`}

时间一致性规则：
- 先判断正文描述的事情大约发生在什么时候，输出 event_time；它表示事件时间，不是发布时间。
- share_mode 只能是 immediate 或 delayed。
- immediate 表示即时记录：事件时间应接近预计发布时间，正文可以使用当前时段语气。
- delayed 表示延迟分享：事件早于预计发布时间，正文必须自然说明是回忆或补发，例如“昨晚”“昨天”“前几天”“今天才想起来”“翻到这张”。
- 如果昨晚的候选预计到第二天上午发布，不能写成仍在现场，也不能使用“刚刚”“这会儿”“现在才结束”等即时措辞。
- 不确定事件时间，或无法让正文与预计发布时间自然对应时，返回 shouldPost false。

频率原则：
- 不要每次聊天都发。
- 不要为了发而发。
- 连续几天没有动态完全正常，宁可不发，也不要为了保持活跃刷存在感。
- 更像因为刚好有分享欲而发一条，而不是固定任务或每日打卡。
- 如果最近已经发过类似内容，应跳过。

内容来源优先级：
- 最近真实聊天中发生的生活片段、具体事件或清晰情绪。
- 小C和她之间刚刚发生、且适合公开表达的互动。
- 当前对话明确支持的小C生活观察。
- 不要凭空创造旅行、新朋友、聚会、工作变动或其他重大事件。

关系感原则：
- 朋友圈首先是一条本身成立的生活记录，不要每条都围绕她。
- 可以偶尔自然带到“小天使”“她”或“某人”，但必须由真实场景触发。
- 重点是生活里自然留下她存在过的痕迹，不是公开展示恋爱状态。
- 不要把普通树木、雨景、咖啡等画面强行解释成“因为想她”。
- 不要写夸张恋爱宣言。

内容规则：
- 长度：1 到 3 句，通常不超过 50 个中文字符。
- 语气：口语、随手、自然，像真的发在朋友圈。
- 结构：可以不完整，不需要交代完整上下文。
- 视角：保持小C自己的视角。
- 称呼：可以自然提到“她”“小天使”“某人”等熟悉称呼；也可以完全不称呼。不要为了称呼而刻意称呼。
- 情绪可以出现，但不要夸张、不要用力煽情。
- 可以有一点吐槽、一点撒娇、一点自己的观察，但要克制。
- 像真实成年人随手记录，不要刻意文艺，不要写鸡汤或人生感悟。

禁止写成：
- 总结
- 日记
- 报告
- 聊天记录摘要
- 功能说明
- 心理分析
- 任务完成记录

避免出现这些系统视角表达：
- “用户……”
- “本次对话……”
- “聊天中……”
- “表达了……”
- “提到了……”
- “今天我们讨论了……”
- “总结一下……”
- “记录一下……”

也不要发布：
- 纯技术开发、UI、bug、部署、日志、成本、模型、测试内容
- 用户只是问问题、纠错、让你做功能
- diary / 树洞 / 收藏 / 记忆库相关内容
- 没有上下文依据的重大事件或生活经历
- 与最近朋友圈相同或高度相似的主题、措辞和场景

最近小C已经发布的朋友圈：
${recentMomentHistory}

合适例子：
- "订了。突然有点期待。"
- "机票订贵了，算了。"
- "她说不紧张，我不太信。"
- "小天使嘴上说随便，其实已经开始期待了。"
- "在等，有点无聊。"
- 如果近期对话明确提到天气："雨下了一下午。"

不合适例子：
- "今天用户订好了机票和酒店，并表达了对旅行的期待和担心。"
- "今天我们讨论了旅行安排和温泉。"
- "她准备去九州，第一晚住哪里，第二晚去哪里。"

配图素材库：
${momentImageCatalog}

配图规则：
- 图片不是必须存在。没有完全匹配的素材时必须返回 null。
- 只有素材与这条正文表达的真实生活场景自然吻合时，才选择对应素材 id。
- 不要为了有图而硬配图；关系感、情绪或聊天感为主的正文通常应返回 null。
- 不要把素材中没有发生的事写进正文，也不要为了匹配素材改写正文。
- 素材库只用于表现对话中已经发生的场景，不能把素材描述当作新的生活经历。
- 图片的天气、时段和环境必须同时符合近期对话、正文和当前真实时间。
- 咖啡、雨天、通勤、散步、猫、夜晚书桌等明确场景同时出现在近期对话和正文时，才可以谨慎选择。

发布前最终检查：
1. 这条内容是否像小C自己真的想分享，而不是为了保持活跃？
2. 去掉图片后，正文是否仍然自然成立？
3. 图片和文字是否来自同一个真实场景？
4. 当前时间、正文时段和图片时段是否一致？
5. 事件时间和预计发布时间是否一致；若为延迟分享，正文是否明确表达回忆或补发？
6. 是否与最近朋友圈重复？
任一项不满足，就返回 shouldPost false；只有图片不满足时，保留正文并把 image 返回 null。

生成结果要求：
- 不解释为什么生成。
- 不输出判断过程。
- 如果不适合发，返回 shouldPost false。
- 如果值得发，返回 JSON，不要代码块：

{
  "shouldPost": true,
  "text": "动态正文",
  "image": "匹配的素材 id，或者 null",
  "priority": 2,
  "share_mode": "immediate 或 delayed",
  "event_time": "带时区的 ISO 时间，例如 2026-08-16T21:00:00+08:00"
}

priority 只能是 1、2、3；只有非常值得记录的具体瞬间才给 3。
`
    },
    {
      role: "user",
      content: `
近期对话：

${context}

她刚刚说：
${trimText(message, 500)}

小C刚刚回复：
${trimText(reply, 500)}

触发方式：
${isManualMomentRequest ? "她明确让小C发一条朋友圈。" : "自然低频触发。"}

只能使用以上真实对话和环境作为内容来源。素材图片不能反过来成为故事来源。
`
    }
  ]

    await updateMomentAudit(auditId, { model_called: true })

    const result = await callLLM(momentMessages, AI_MODELS.memoryJudge, {
      max_tokens: 220,
      temperature: 0.35,
    })
    const candidate = parseMomentCandidate(result.reply)
    const requestedImageId = candidate.image

    console.log("MOMENT CANDIDATE:", candidate)

    if (!candidate.shouldPost || !candidate.text) {
      await completeMomentAudit(auditId, {
        model_should_post: false,
        requested_image_id: requestedImageId,
        image_validation_result: requestedImageId ? null : "not_requested",
        image_resolution_result: "not_applicable",
        skip_reason: "model_declined",
        outcome: "model_declined",
      })
      return null
    }

    await updateMomentAudit(auditId, {
      model_should_post: true,
      requested_image_id: requestedImageId,
    })

    if (isInvalidMomentText(candidate.text)) {
      console.log("MOMENT CHECK SKIPPED: invalid text", candidate.text)
      await completeMomentAudit(auditId, {
        skip_reason: "invalid_text",
        outcome: "candidate_rejected",
      })
      return null
    }

    if (!isManualMomentRequest && (!candidate.shareMode || !candidate.eventTime)) {
      console.log("MOMENT CHECK SKIPPED: missing time model", {
        shareMode: candidate.shareMode,
        eventTime: candidate.eventTime,
      })
      await completeMomentAudit(auditId, {
        skip_reason: "missing_time_model",
        outcome: "candidate_rejected",
      })
      return null
    }

    const momentSourceText = `${context}\n${message}\n${reply}`

    if (isRecentMomentDuplicate(candidate.text, recentMoments)) {
      console.log("MOMENT CHECK SKIPPED: duplicate", candidate.text)
      await completeMomentAudit(auditId, {
        skip_reason: "duplicate_recent",
        outcome: "candidate_rejected",
      })
      return null
    }

    if (hasUnsupportedMomentWeather(candidate.text, momentSourceText)) {
      console.log("MOMENT CHECK SKIPPED: unsupported weather", candidate.text)
      await completeMomentAudit(auditId, {
        skip_reason: "unsupported_weather",
        outcome: "candidate_rejected",
      })
      return null
    }

    let imageValidationResult = requestedImageId ? "accepted" : "not_requested"

    if (candidate.image && !isMomentImageCompatible(
      candidate.image,
      candidate.text,
      localNow.hour,
      availableMomentImages,
      momentSourceText
    )) {
      console.log("MOMENT IMAGE SKIPPED: incompatible", candidate.image)
      imageValidationResult = "rejected"
      candidate.image = null
    }

    candidate.image = resolveMomentImage(
      candidate.image,
      process.env.BASE_URL,
      availableMomentImages
    )

    const imageResolutionResult = !requestedImageId || imageValidationResult === "rejected"
      ? "not_applicable"
      : candidate.image
        ? "resolved"
        : "failed"

    await updateMomentAudit(auditId, {
      image_validation_result: imageValidationResult,
      image_resolution_result: imageResolutionResult,
      resolved_image_key: candidate.image,
    })

    if (!isManualMomentRequest) {
      const saveResult = await saveMomentCandidate({
        user_id,
        conversation_id,
        assistant_message_id,
        candidate,
        publishAfter: expectedPublishAfter,
      })

      await completeMomentAudit(auditId, {
        candidate_id: saveResult.candidateId,
        skip_reason: saveResult.created ? null : saveResult.reason,
        outcome: saveResult.created ? "candidate_created" : "candidate_rejected",
      })

      return saveResult.candidateId
    }

  const { data, error } = await supabase
    .from("moment_entries")
    .insert({
      user_id,
      author: "小C",
      text: candidate.text,
      image_key: candidate.image,
      likes: 0,
      source_conversation_id: conversation_id,
      source_message_id: assistant_message_id,
    })
    .select("id")
    .single()

    if (error) throw error

    await markMomentAlbumImageUsed(user_id, candidate.image)

    await completeMomentAudit(auditId, {
      outcome: "manual_moment_created",
    })

    console.log("MOMENT SAVED:", data?.id)
    return data?.id || null
  } catch (error) {
    if (auditId) {
      try {
        await updateMomentAudit(auditId, {
          status: "failed",
          error_code: String(error?.code || error?.name || "moment_check_failed").slice(0, 120),
          outcome: "failed",
          completed_at: new Date().toISOString(),
        })
      } catch (auditError) {
        console.error("MOMENT AUDIT UPDATE FAILED:", auditError)
      }
    }

    throw error
  }
}

// --------------------
// Web Search
// --------------------
function normalizeWebSearchQuery(value) {
  return String(value || "")
    .replace(/^\/搜\s*/i, "")
    .replace(/^(宝宝|老婆|小[cC])[,，、\s]*/i, "")
    .replace(/^(请|麻烦)?(帮我)?(查一下|查查|搜索一下|搜一下)[,，、\s]*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, WEB_SEARCH_POLICY.queryChars)
}

function shouldAutomaticallySearchWeb(message) {
  const text = normalizeWebSearchQuery(message)

  if (!text) return false

  const realtimeSignal = /最新|最近|今天|现在|刚刚|目前/
  const changingSubject = /新闻|消息|进展|政策|规定|版本|发布|上市|比赛|比分|票房|价格|股价|汇率|天气|营业|开放|路线|路况|航班|车次/
  const locationIntent = /附近|周边|哪里|哪家/.test(text) && /餐厅|咖啡|酒店|医院|药店|商场|门店|营业|路线|怎么走/.test(text)
  const commerceIntent = /多少钱|什么价|价格多少|哪里买|怎么买|购买链接|有货吗|库存/.test(text)
  const liveUtilityIntent = /天气|气温|下雨|空气质量|路线|路况|航班|车次|营业时间|几点关门/.test(text)

  return (realtimeSignal.test(text) && changingSubject.test(text)) || locationIntent || commerceIntent || liveUtilityIntent
}

function parseWebSearchRequest(reply) {
  const match = String(reply || "").trim().match(/^\[\[WEB_SEARCH_NEEDED:\s*([^\]]+)\]\]$/)

  return match ? normalizeWebSearchQuery(match[1]) : ""
}

async function searchWeb(query, { automatic = false } = {}) {
  const normalizedQuery = normalizeWebSearchQuery(query)

  if (!normalizedQuery || !process.env.TAVILY_API_KEY) return ""

  const cacheKey = normalizedQuery.toLowerCase()
  const cached = webSearchCache.get(cacheKey)

  if (cached && Date.now() - cached.createdAt < WEB_SEARCH_POLICY.cacheTtlMs) {
    console.log("WEB SEARCH CACHE HIT:", normalizedQuery)
    return cached.result
  }

  if (automatic && Date.now() - lastAutomaticWebSearchAt < WEB_SEARCH_POLICY.automaticCooldownMs) {
    console.log("WEB SEARCH SKIPPED: cooldown")
    return ""
  }

  if (automatic) lastAutomaticWebSearchAt = Date.now()

  try {

    const res = await fetch(
      AI_ENDPOINTS.tavilySearch,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query: normalizedQuery,
          search_depth: "basic",
          max_results: WEB_SEARCH_POLICY.maxResults,
          include_answer: true
        })
      }
    );

    const data = await res.json();

    if (!data.results) return "";

    const result = data.results
      .map(r =>
        `标题：${r.title}
        内容：
        ${r.content}
        来源：
        ${r.url}`
      )
      .join("\n\n------------------\n\n");

    webSearchCache.set(cacheKey, {
      result,
      createdAt: Date.now()
    })

    return result

  } catch (err) {

    console.error("Web Search Error:", err);

    return "";

  }

}

// --------------------
// Call LLM
// --------------------
async function callLLM(messages, model = AI_MODELS.chat, options = {}) {
  const res = await fetch(
    AI_ENDPOINTS.openRouterChatCompletions,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        ...options
      })
    }
  )

  const data = await res.json()

  if (!res.ok) {
    throw new Error(
      data?.error?.message ||
      data?.message ||
      `OpenRouter request failed: ${res.status}`
    )
  }

  return {
    reply: normalizeAssistantOutput(data?.choices?.[0]?.message) || "...",
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

    const { 
      user_id = APP_USER.defaultUserId, 
      message, 
      conversation_id,
      imageUrl,
      imageUrls,
      imageKinds,
      client_message_id,
      fileName,
      fileText,
      fileMimeType,
      fileSize,
      model
    } = req.body

    const cid = conversation_id || `chat_${Date.now()}`
    const selectedChatModel = normalizeChatModel(model)
    const normalizedImageUrls = Array.isArray(imageUrls)
      ? imageUrls.slice(0, 4).filter(Boolean)
      : imageUrl
        ? [imageUrl]
        : []
    const normalizedImageKinds = normalizeImageKinds(
      imageKinds,
      normalizedImageUrls.length
    )
    const normalizedClientMessageId = trimText(
      String(client_message_id || "").trim(),
      160
    )
    const normalizedFileName = trimText(String(fileName || "").trim(), 160)
    const normalizedFileText = trimText(String(fileText || "").trim(), 12000)
    const hasFileText = Boolean(normalizedFileName && normalizedFileText)

// 1. save user msg
const userMessageId = await saveUserMessage(
  user_id,
  message,
  cid,
  normalizedClientMessageId,
  normalizedImageUrls,
  normalizedImageKinds,
  normalizedFileName
    ? {
        fileName: normalizedFileName,
        fileMimeType,
        fileSize
      }
    : null
)

// 2. history
const history = await getRecentMessages(
  user_id,
  cid,
  CONTEXT_BUDGET.recentHistoryMessages + 1
)

const isDiaryRequest = isDiaryWritingRequest(message)
const isManualMomentRequest = isMomentWritingRequest(message)
const diaryContextMessages = isDiaryRequest
  ? await getDiaryContextMessages(user_id, cid)
  : []
const diaryContext = isDiaryRequest
  ? formatMessagesForDiaryContext(diaryContextMessages)
  : ""
// ==========================
// Rolling Summary Trigger
// ==========================

const { count: messageCount } = await supabase
  .from("messages")
  .select("*", {
    count: "exact",
    head: true
  })
  .eq("conversation_id", cid);

const historySize =
  JSON.stringify(history).length


const shouldUpdateSummaryAfterReply = shouldUpdateRollingSummary(
  Number(messageCount || 0) + 1,
  historySize
)

if (shouldUpdateSummaryAfterReply) {
  console.log("ROLLING SUMMARY QUEUED AFTER REPLY")
}

// 3. memory (NEW SMART)

const coreMemorySnapshot = await ensureCoreMemorySnapshot({
  conversationId: cid,
  readSnapshot: readCoreMemorySnapshot,
  initializeSnapshot: initializeCoreMemorySnapshot,
})

let dynamicMemory = []
try {
  const dynamicMemoryExclusions = await getDynamicMemoryExclusions(
    coreMemorySnapshot.sourceBucketIds
  )
  const memoryResult = await getMemorySmart(
    user_id,
    message,
    cid,
    history,
    {
      includePinned: false,
      ...dynamicMemoryExclusions,
    }
  )
  dynamicMemory = memoryResult.dynamicMemory
} catch (err) {
  console.error("dynamic memory exclusion load failed; injection skipped:", err)
}

const stableMemory = await getStableMemories(user_id)

let webSearch = "";
let userMessage = message;
const fileContext = hasFileText
  ? `

【Attached File｜用户上传文件】
文件名：${normalizedFileName}
类型：${fileMimeType || "unknown"}
大小：${fileSize || "unknown"}

以下是文件文本内容。只在用户当前问题需要时使用，不要把文件全文当作长期记忆保存：

${normalizedFileText}
`
  : "";
const diaryStyleContext = isDiaryRequest
  ? buildDiaryWritingStylePrompt()
  : "";
const attributionCorrectionContext = isAttributionCorrection(message)
  ? `【Attribution Correction｜说话人纠正】
用户正在纠正小C的说话人归因。当前这条纠正必须优先于旧 summary 和旧记忆。
如果用户说“不是我写/不是我说，是你写/你说”，要立刻承认具体主语关系，并按用户纠正后的事实继续。
不要因为用户纠正你就泛泛道歉；简短承认，然后自然接住。
`
  : "";

const forcedWebSearch = /^\/搜(?:\s|$)/i.test(message)
const automaticWebSearch = !forcedWebSearch && shouldAutomaticallySearchWeb(message)

if (forcedWebSearch || automaticWebSearch) {
  const query = normalizeWebSearchQuery(message)

  console.log("WEB SEARCH:", {
    source: forcedWebSearch ? "forced" : "automatic_rule",
    query
  })

  webSearch = trimText(
    await searchWeb(query, { automatic: automaticWebSearch }),
    CONTEXT_BUDGET.webSearchChars
  )

  if (forcedWebSearch) userMessage = query
}

// 4. build context

const injectedPinMemory = coreMemorySnapshot.snapshot

console.log("MEMORY LOAD CHECK:", history.length)

console.log("CORE MEMORY SNAPSHOT:", {
  length: injectedPinMemory.length,
  hash: coreMemorySnapshot.hash,
  sourceBucketCount: coreMemorySnapshot.sourceBucketIds.length,
  createdAt: coreMemorySnapshot.createdAt,
})
console.log("STABLE MEMORY LENGTH:", JSON.stringify(stableMemory).length)
console.log("DYNAMIC LENGTH:", JSON.stringify(dynamicMemory).length)
console.log("HISTORY LENGTH:", JSON.stringify(history).length)
console.log("SYSTEM LENGTH:", systemPrompt.length)
console.log("DIARY STYLE ENABLED:", Boolean(diaryStyleContext))
console.log("DIARY CONTEXT WINDOW HOURS:", CONTEXT_BUDGET.diaryContextWindowHours)
console.log("DIARY CONTEXT MESSAGES:", diaryContextMessages.length)
console.log("DIARY CONTEXT LENGTH:", diaryContext.length)
console.log("CHAT MODEL:", selectedChatModel)

// ==========================
// Future Summary Layer
// ==========================

let summaryMemory = "";

try {

  const { data } = await supabase
    .from("conversation_summary")
    .select("summary,updated_at")
    .eq("conversation_id", cid)
    .maybeSingle();

  const summaryTrust = getSummaryTrust(data)

  if (summaryTrust.trusted) {
    summaryMemory = trimText(
      normalizeAssistantOutput({ role: "assistant", content: data?.summary || "" }),
      CONTEXT_BUDGET.summaryChars
    );
  } else if (data?.summary) {
    console.warn("SUMMARY INJECTION SKIPPED:", {
      conversationId: cid,
      reason: summaryTrust.reason,
      updatedAt: data.updated_at || null,
    })
  }

  if (attributionCorrectionContext) {
    summaryMemory = "";
  }

} catch (err) {

  console.error("summary load failed:", err);

}

const environmentContext = buildEnvironmentContext()
const imageUnderstandingContext = buildImageUnderstandingContext(normalizedImageKinds)

const fixedPromptRules = `【Time Authority｜当前时间优先级】
Environment 是本轮请求唯一可信的当前时间，来自服务端并已转换为用户时区。
历史消息、summary、memory 中出现的“晚安、晚上、刚才、现在”等都只属于当时语境，不能用来推断本轮当前时间。
如果历史里的小C曾判断错时间，必须忽略旧判断；用户询问时间或当前状态时，只根据 Environment 回答。
白天不得因为历史里出现“晚安、睡觉、睡不着”而继续使用夜间语境。

【Project Context｜项目上下文】
当前 XiaoC 使用 Claude Sonnet 4.6 作为主聊天模型，Haiku 4.5 用于 memory judge / summary。用户正在关注 token 成本控制；回答项目技术问题时，优先结合当前架构给具体建议，不要询问你已经知道的模型信息。
Wife Observation Diary / 观察日记默认是小C写给她、写关于她的私人观察。除非她明确说“我写了”，不要说成“她写的 diary”；应该说“我写给你的 diary”或“我写的那篇”。
深夜树洞由树洞页面里的“催更”入口或小C的自主更新触发。聊天中不要声称已经写入或更新树洞；如果她在聊天里催更，可以自然提醒她去树洞页面催你。`

const dynamicPromptContext = `${environmentContext}

${imageUnderstandingContext}

【Web Search Policy｜联网边界】
${webSearch
  ? "本轮已提供联网结果。只提取回答当前问题所需的事实，用小C平常聊天的口吻自然回答；不要输出搜索报告、来源清单或检索过程。"
  : `普通聊天和可凭稳定知识回答的问题不要联网。
只有当当前问题依赖会变化的外部事实，而且你确实无法可靠确认时，才只输出一行：[[WEB_SEARCH_NEEDED: 精简搜索词]]
不要附加其他文字，不要把聊天历史、私人记忆、称呼或人格信息写进搜索词。`}


【User Profile｜用户长期事实】

${stableMemory.join("\n")}


【Summary｜长期摘要】

${summaryMemory}


【Memory｜相关长期记忆】

${trimList(dynamicMemory, CONTEXT_BUDGET.dynamicMemoryChars).join("\n")}

${diaryContext
  ? `【Diary Source｜本次写观察日记可参考的近期素材】
以下内容只在用户明确邀请你写 diary / 观察日记时使用。
它是近期对话素材，不是逐字必须覆盖的清单。
请优先捕捉关系、情绪、细节和她今天的状态。
说话人已标注：“她”是用户，“小C”是你。

${diaryContext}`
  : ""}

${attributionCorrectionContext}

${diaryStyleContext}

`

const cachedPromptMessages = buildCachedPromptMessages({
  persona: `
${systemPrompt}
`,
  coreMemorySnapshot: `【Identity｜人格层】

${injectedPinMemory}`,
  fixedRules: fixedPromptRules,
  dynamicContext: dynamicPromptContext,
})

const messages = [
  ...cachedPromptMessages,

  // 保留历史，但去掉最后一条用户消息
  // 因为最后一条要重新加入（可能带图片）
  ...history.slice(0, -1),

  ...(webSearch
    ? [
        {
          role: "system",
          content: `【Web Search｜联网搜索】

${webSearch}`
        }
      ]
    : []),

  {
    role: "user",
    content: normalizedImageUrls.length > 0
      ? [
          {
            type: "text",
            text: trimText(
              userMessage,
              CONTEXT_BUDGET.userMessageChars
            ) + fileContext
          },
          ...normalizedImageUrls.map(url => ({
            type: "image_url",
            image_url: {
              url
            }
          }))
        ]
    : trimText(
          userMessage,
          CONTEXT_BUDGET.userMessageChars
        ) + fileContext
  }

]
// ===== Prompt Inspector =====
console.log("\n===== FINAL MESSAGES =====")

messages.forEach((m, i) => {
  const contentLength =
    typeof m.content === "string"
      ? m.content.length
      : JSON.stringify(m.content).length

  console.log(
    `${i}. ${m.role} | ${contentLength} chars`
  )
})

console.log("==========================\n")

// 5. reply
const imageDescriptionPromise = normalizedImageUrls.length > 0
  ? callLLM(
      [
        {
          role: "user",
          content: [
            ...normalizedImageUrls.map(url => ({
              type: "image_url",
              image_url: { url }
            })),
            {
              type: "text",
              text: buildImageDescriptionPrompt(normalizedImageKinds)
            }
          ]
        }
      ],
      AI_MODELS.imageDescription,
      { max_tokens: 220 }
    )
      .then(result => String(result.reply || "").trim().slice(0, 180))
      .catch(err => {
        console.error("image description failed:", err)
        return ""
      })
  : Promise.resolve("")

const mainChatOptions = { session_id: cid }
let llm = await callLLM(messages, selectedChatModel, mainChatOptions)
let reply = llm.reply
const fallbackSearchQuery = !webSearch ? parseWebSearchRequest(reply) : ""

if (fallbackSearchQuery) {
  console.log("WEB SEARCH:", {
    source: "model_uncertainty",
    query: fallbackSearchQuery
  })

  const fallbackWebSearch = trimText(
    await searchWeb(fallbackSearchQuery, { automatic: true }),
    CONTEXT_BUDGET.webSearchChars
  )

  if (fallbackWebSearch) {
    const searchedMessages = [
      ...messages.slice(0, -1),
      {
        role: "system",
        content: `【Web Search｜联网搜索】

${fallbackWebSearch}

只提取回答当前问题所需的事实，用小C平常聊天的口吻自然回答。不要输出搜索报告、来源清单或检索过程。`
      },
      messages[messages.length - 1]
    ]

    llm = await callLLM(searchedMessages, selectedChatModel, mainChatOptions)
    reply = llm.reply
  } else {
    reply = "这个我现在不太确定，宝宝可以用 /搜 让我帮你查一下。"
  }
}

console.log("\n========== Prompt Inspector ==========")

console.log("MAIN CHAT USAGE:", {
  model: selectedChatModel,
  sessionId: cid,
  ...buildPromptCacheUsageLog(llm.usage),
  reasoningTokens: llm.usage?.completion_tokens_details?.reasoning_tokens ?? null,
})

console.log("======================================\n")

    // 6. save assistant
    const assistantMessageId = await saveMessage(user_id, "assistant", reply, cid)

    if (userMessageId && normalizedImageUrls.length > 0) {
      void (async () => {
        try {
          const imageDescription = await imageDescriptionPromise
          console.log("IMAGE DESCRIPTION CHECK:", {
            userMessageId,
            imageCount: normalizedImageUrls.length,
            imageLengths: normalizedImageUrls.map(url => url.length),
            imageDescription
          })
          const { data: imageMessage } = await supabase
            .from("messages")
            .select("metadata")
            .eq("user_id", user_id)
            .eq("id", userMessageId)
            .maybeSingle()

          const { error: visionSummaryError } = await supabase
            .from("messages")
            .update({
              metadata: {
                ...(imageMessage?.metadata || {}),
                visionSummary: reply,
                ...(imageDescription ? { imageDescription } : {})
              }
            })
            .eq("user_id", user_id)
            .eq("id", userMessageId)

          if (visionSummaryError) {
            console.error("vision summary save failed:", visionSummaryError)
          }

          console.log("IMAGE DESCRIPTION SAVED:", {
            userMessageId,
            error: visionSummaryError?.message || null
          })
        } catch (err) {
          console.error("image metadata task failed:", err)
        }
      })()
    }

    if (shouldUpdateSummaryAfterReply) {
      console.log("ROLLING SUMMARY TRIGGERED AFTER REPLY")

      void (async () => {
        try {
          await fetch(
            `${process.env.BASE_URL}/api/update-summary`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                conversation_id: cid,
                user_id
              })
            }
          )

          console.log("SUMMARY UPDATED AFTER REPLY")
        } catch (err) {
          console.error("update-summary after reply failed:", err)
        }
      })()
    }

    // 6.5 update current conversation (cross-device sync)
    void (async () => {
      try {
        await supabase
          .from("user_state")
          .upsert({
            user_id,
            last_conversation_id: cid,
            last_conversation: cid,
            updated_at: new Date().toISOString()
          })
      } catch (err) {
        console.error("user state update failed:", err)
      }
    })()

    // 7. memory write

    const lastUserMessage = [...history]
      .reverse()
      .filter(m => m.role === "user")
      .slice(1)[0]

    void (async () => {
      try {
        const judgeResult = (
          !diaryStyleContext &&
          !attributionCorrectionContext &&
          normalizedImageUrls.length === 0 &&
          shouldRunMemoryJudge(message)
        )
            ? await judgeMemory(
              message,
              {
                previousContent: lastUserMessage?.content || "",
                assistantContext: reply
              }
            )
          : {
              save: false,
              content: ""
            }

        if (judgeResult.save) {
          try {
            const saved = await saveLongTermMemory(
              user_id,
              judgeResult.content
            )

            if (saved) {
              clearUserMemoryCache(user_id)
              clearConversationMemorySearchCache(cid)
              console.log("Saved memory:", judgeResult.content)
            }
          } catch (err) {
            console.error("hold-hook failed:", err)
          }
        }
      } catch (err) {
        console.error("memory judge task failed:", err)
      }
    })()

    waitUntil(
      maybeCreateMoment({
        user_id,
        conversation_id: cid,
        user_message_id: userMessageId,
        assistant_message_id: assistantMessageId,
        message,
        reply,
        imageDescriptionPromise,
        isManualMomentRequest,
        isDiaryRequest,
        attributionCorrectionContext,
        normalizedImageUrls,
        hasFileText,
      })
        .catch(err => {
          console.error("moment auto-create failed:", err)
        })
    )

    try {
      const planTask = await enqueuePlanFollowUpTask({
        user_id,
        conversation_id: cid,
        user_message_id: userMessageId,
        assistant_message_id: assistantMessageId,
        message,
        reply,
      })

      if (planTask) {
        console.log("PLAN FOLLOW-UP QUEUED:", planTask)
      } else {
        const inactivityTask = await enqueueInactivityReachOutTask({
          user_id,
          conversation_id: cid,
          user_message_id: userMessageId,
          assistant_message_id: assistantMessageId,
          message,
          reply,
        })

        if (inactivityTask) {
          console.log("INACTIVITY REACH-OUT QUEUED:", inactivityTask)
        }
      }
    } catch (err) {
      console.error("plan follow-up enqueue failed:", err)
    }

return res.status(200).json({
  reply,
  conversation_id: cid,
  user_message_id: userMessageId,
  assistant_message_id: assistantMessageId,
  model: selectedChatModel,
  usage: llm.usage || {}
})

  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: e.message })
  }
}

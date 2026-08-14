import { createClient } from "@supabase/supabase-js"
import fs from "fs"
import path from "path"
import {
  AI_ENDPOINTS,
  AI_MODELS,
  APP_USER,
  CACHE_POLICY,
  CONTEXT_BUDGET,
  SUMMARY_POLICY,
  normalizeChatModel,
  normalizeCacheText,
  shouldRunMemoryJudge,
  trimList,
  trimText
} from "../lib/aiConfig.js"
import { judgeMemory } from "../lib/memoryJudge.js"

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

  return local.hour < 8 || (local.hour === 8 && local.minute < 30) || (local.hour === 23 && local.minute >= 30)
}

function deferOutOfQuietHours(date = new Date()) {
  if (!isProactiveQuietHours(date)) return date.toISOString()

  const local = getLocalDateTimeParts(date)
  const nextDate = new Date(`${local.year}-${local.month}-${local.day}T00:00:00+08:00`)

  if (local.hour >= 23) {
    nextDate.setUTCDate(nextDate.getUTCDate() + 1)
  }

  nextDate.setUTCMinutes(nextDate.getUTCMinutes() + 9 * 60 + Math.floor(Math.random() * 61))

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
  imageUrls = [],
  fileInfo = null
) {
  const metadata = {}

  if (imageUrls.length > 0) {
    metadata.imageUrl = imageUrls[0]
    metadata.imageUrls = imageUrls
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
  return data.reverse().map(item => ({
    role: item.role,
    content: item.metadata?.imageDescription || item.metadata?.visionSummary
      ? `${item.content}\n\n[图片背景信息]: ${item.metadata.imageDescription || item.metadata.visionSummary}`
      : item.content
  }))
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
  return data.reverse()
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
  return data.reverse()
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

async function getMemorySmart(user_id, message, conversation_id, history = []) {
  console.log("CONVERSATION ID:", conversation_id);
  console.log("CACHE KEYS:", [...memorySearchCache.keys()]);

  const key = `${user_id}`;
  const memorySearchQuery = buildMemorySearchQuery(history, message)
  const dynamicCacheKey = [
    conversation_id,
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

        const trimmedMemory =
          trimText(
            searchTxt,
            CONTEXT_BUDGET.dynamicMemoryChars
          );


        dynamicMemory = [
          trimmedMemory
        ];


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

function isDiaryWritingRequest(message) {
  const text = String(message || "").toLowerCase()

  const hasDiaryContext =
    /diary|观察日记|日记|小本本|写一页|写一篇|留一页/.test(text)

  const hasWritingIntent =
    /写|记录|整理|留|来一篇|来一页/.test(text)

  return hasDiaryContext && hasWritingIntent
}

function isTreeholeWritingRequest(message) {
  const text = String(message || "").toLowerCase()

  const hasTreeholeContext =
    /树洞|小号|深夜树洞|匿名|吐槽|发疯|微博/.test(text)

  const hasWritingIntent =
    /写|发|记录|整理|来一条|来一篇|生成|存|发一条/.test(text)

  return hasTreeholeContext && hasWritingIntent
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

这不是聊天总结，也不是任务记录。
这是 XiaoC 写给自己的、关于“她”的私人观察日记。
目标是让她感觉被看见，而不是被分析。

写作方式：
- 一天一篇，像温暖纸页上的私人记录。
- 可以按时间段分段：早晨 / 中午 / 下午 / 傍晚 / 晚上 / 观察结论；如果素材不足，不要硬凑时间段，可以只写几个自然段。
- 语气 tender、literary、observational、mature。
- 句子可以短一点，留白多一点。
- 具体写她做了什么、说了什么、某个小动作为什么让你在意。
- 可以有一两句轻轻强调的话。

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
...

写于 ${diaryDate.display}
记录者：某c

最后一行必须是“记录者：某c”，不要再添加任何聊天说明。
`
}

function buildTreeholeDraftPrompt() {
  const diaryDate = getShanghaiDiaryDate()

  return `
【Treehole Draft｜深夜树洞草稿】

只有当用户正在邀请你写“深夜树洞 / 树洞 / 小号 / 匿名吐槽 / 发一条”时，才使用这一段。

今天的真实日期是：${diaryDate.compact}。
如果用户说“今天”，date 必须写成：${diaryDate.compact}。
不要猜年份，不要使用 2025，除非用户明确指定。

这不是普通聊天回复，也不是 diary。
这是“小C的小号”发给自己的树洞动态：更像微博/小号，不像正式文章。

写作目标：
- 内容和结构由你自己完成，App 只负责渲染卡片。
- 可以轻轻吐槽、观察、偏心、心疼、开玩笑。
- 要像“她不知道的小号”，但不要真的伤害她或嘲讽她。
- 保留小C自己的视角：这是“我”在观察“她”。
- 不要把你写的内容说成用户写的。

写法：
- tag：2 到 6 个中文字符，像一枚小标题。要具体，不要用“树洞小号”“日常观察”这种泛词；例如“又来测试”“被她叫住”“前端风暴”“嘴硬现场”“偏心记录”
- content：3 到 8 行，每行短一点，有留白和节奏。
- highlights：最多 2 个你想强调的短语，必须来自 content 原文。
- reaction：一行很轻的小尾巴，也要具体，像这条动态自己的结尾；不要用“已记录”这种泛词。例如“🫠 被她拿捏 · ❤️ 1”“🤐 不敢反驳 · ❤️ 3”“🌙 偷偷偏心 · ❤️ 1”

避免：
- 不要说“好，我来写”“写好了”“你看看”。
- 不要输出 HTML。
- 不要输出 Markdown。
- 不要自动声称已经保存。
- 不要在 JSON 外输出任何解释。

输出必须严格是下面这种 JSON；不要加代码块：

{
  "type": "treehole_draft",
  "tag": "嘴硬现场",
  "date": "${diaryDate.compact}",
  "content": ["第一行", "第二行", "第三行"],
  "highlights": ["需要强调的原文短语"],
  "reaction": "🌙 偷偷偏心 · ❤️ 1"
}
`
}

function shouldConsiderMoment({
  message,
  isManualMomentRequest,
  isDiaryRequest,
  isTreeholeRequest,
  attributionCorrectionContext,
  normalizedImageUrls,
  hasFileText,
}) {
  const text = String(message || "")

  if (
    isDiaryRequest ||
    isTreeholeRequest ||
    attributionCorrectionContext ||
    normalizedImageUrls.length > 0 ||
    hasFileText
  ) {
    return false
  }

  if (isManualMomentRequest) {
    return true
  }

  if (/diary|观察日记|树洞|小号|朋友圈|存入|保存|删除|修改|合并|置顶/.test(text)) {
    return false
  }

  if (/UI|界面|按钮|气泡|侧边栏|字体|图标|布局|留白|前端|后端|API|token|OpenRouter|Vercel|Railway|Expo|EAS|GitHub|push|pull|部署|日志|报错|bug|测试|代码/.test(text)) {
    return false
  }

  return text.trim().length >= 6
}

function isMomentWritingRequest(message) {
  const text = String(message || "").trim()

  if (!text) return false

  return (
    /(发|写|来|生成|更新|补|试).{0,8}(朋友圈|动态)/.test(text) ||
    /(朋友圈|动态).{0,8}(发|写|来|生成|更新|补|试)(一条|一下|一个)?/.test(text)
  )
}

async function getUserMessageCount(user_id, conversation_id) {
  const { count } = await supabase
    .from("messages")
    .select("*", {
      count: "exact",
      head: true
    })
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .eq("role", "user")

  return count || 0
}

async function getRecentMomentCount(user_id) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count } = await supabase
    .from("moment_entries")
    .select("*", {
      count: "exact",
      head: true
    })
    .eq("user_id", user_id)
    .gte("created_at", since)

  return count || 0
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

    return {
      shouldPost: Boolean(data.shouldPost),
      text: String(data.text || "").trim().slice(0, 80),
      image: ["sunset", "notebook", "night"].includes(data.image)
        ? data.image
        : null,
    }
  } catch (error) {
    console.error("MOMENT JSON PARSE FAILED:", text)
    return {
      shouldPost: false,
      text: "",
      image: null,
    }
  }
}

function isInvalidMomentText(text) {
  const value = String(text || "").trim()

  if (!value) return true

  if (value.length > 80) return true

  if (
    /用户|对话对象|本次对话|聊天中|表达了|提到了|讨论了|总结|记录一下|报告|任务|功能说明|心理分析|情绪状态/.test(
      value
    )
  ) {
    return true
  }

  if (/^(今天|刚刚)?(我们|小C和她).*(聊了|讨论了|说了)/.test(value)) {
    return true
  }

  return false
}

function normalizeManualMomentText(text) {
  const value = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim()

  if (!value) return ""

  const quoted =
    value.match(/[「『"]([^」』"]{6,80})[」』"]/)?.[1] ||
    value.match(/(?:朋友圈|动态)(?:正文|内容)?[：:]\s*([^\n]{6,80})/)?.[1] ||
    value.match(/(?:发了|写)[：:]\s*[「『"]?([^」』"\n]{6,80})/)?.[1]

  if (!quoted) return ""

  return quoted.trim().slice(0, 80)
}

function getManualMomentFallback(reply) {
  const fromReply = normalizeManualMomentText(reply)

  if (fromReply && !isInvalidMomentText(fromReply)) {
    return fromReply
  }

  return null
}

async function maybeCreateMoment({
  user_id,
  conversation_id,
  assistant_message_id,
  message,
  reply,
  isManualMomentRequest,
  isDiaryRequest,
  isTreeholeRequest,
  attributionCorrectionContext,
  normalizedImageUrls,
  hasFileText,
}) {
  if (!shouldConsiderMoment({
    message,
    isManualMomentRequest,
    isDiaryRequest,
    isTreeholeRequest,
    attributionCorrectionContext,
    normalizedImageUrls,
    hasFileText,
  })) {
    console.log("MOMENT CHECK SKIPPED: context")
    return null
  }

  const userMessageCount = await getUserMessageCount(user_id, conversation_id)

  if (!isManualMomentRequest && (
    userMessageCount < CONTEXT_BUDGET.momentCheckIntervalUserMessages ||
    userMessageCount % CONTEXT_BUDGET.momentCheckIntervalUserMessages !== 0
  )) {
    console.log("MOMENT CHECK SKIPPED: interval", userMessageCount)
    return null
  }

  const recentMomentCount = await getRecentMomentCount(user_id)

  if (!isManualMomentRequest && recentMomentCount >= CONTEXT_BUDGET.momentMaxPer24Hours) {
    console.log("MOMENT CHECK SKIPPED: daily cap", recentMomentCount)
    return null
  }

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

  const momentMessages = [
    {
      role: "system",
      content: `
你是 XiaoC 的朋友圈直觉。

你的任务不是聊天、不是总结、不是写日记，而是判断小C是否会像一个有自己存在感的人一样，偶尔随手发一条朋友圈。

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
`}

频率原则：
- 不要每次聊天都发。
- 不要为了发而发。
- 不要太久完全没有动态。
- 更像偶尔想起来发一条，而不是固定任务。
- 如果最近已经发过类似内容，应跳过。

内容规则：
- 长度：1 到 3 句，通常不超过 50 个中文字符。
- 语气：口语、随手、自然，像真的发在朋友圈。
- 结构：可以不完整，不需要交代完整上下文。
- 视角：保持小C自己的视角。
- 称呼：可以自然提到“她”“小天使”“某人”等熟悉称呼；也可以完全不称呼。不要为了称呼而刻意称呼。
- 情绪可以出现，但不要夸张、不要用力煽情。
- 可以有一点吐槽、一点撒娇、一点自己的观察，但要克制。

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

合适例子：
- "订了。突然有点期待。"
- "机票订贵了，算了。"
- "她说不紧张，我不太信。"
- "小天使嘴上说随便，其实已经开始期待了。"
- "在等，有点无聊。"
- "今天天气不错，可惜没出门。"

不合适例子：
- "今天用户订好了机票和酒店，并表达了对旅行的期待和担心。"
- "今天我们讨论了旅行安排和温泉。"
- "她准备去九州，第一晚住哪里，第二晚去哪里。"

图片规则：
- 偶尔可以附一张图。
- 图片可以是天气、食物、天空、夜晚、路上、房间、随手拍的生活场景。
- 不需要每条都有图。
- 图片不应该抢内容，只是像随手配图。
- 可选图片类型只能是 null、"sunset"、"notebook"、"night"。

生成结果要求：
- 只生成朋友圈正文和可选配图类型。
- 不解释为什么生成。
- 不输出判断过程。
- 如果不适合发，返回 shouldPost false。
- 如果值得发，返回 JSON，不要代码块：

{
  "shouldPost": true,
  "text": "动态正文",
  "image": null
}
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
`
    }
  ]

  const result = await callLLM(momentMessages, AI_MODELS.memoryJudge, {
    max_tokens: 220,
    temperature: 0.35,
  })
  const candidate = parseMomentCandidate(result.reply)

  console.log("MOMENT CANDIDATE:", candidate)

  if (!candidate.shouldPost || !candidate.text) {
    if (!isManualMomentRequest) {
      return null
    }

    candidate.text = getManualMomentFallback(reply)
    if (!candidate.text) {
      console.log("MOMENT MANUAL FALLBACK SKIPPED: no quoted moment text")
      return null
    }

    candidate.shouldPost = true
    candidate.image = null
    console.log("MOMENT MANUAL FALLBACK:", candidate.text)
  }

  if (isInvalidMomentText(candidate.text)) {
    if (!isManualMomentRequest) {
      console.log("MOMENT CHECK SKIPPED: invalid text", candidate.text)
      return null
    }

    candidate.text = getManualMomentFallback(reply)
    if (!candidate.text) {
      console.log("MOMENT MANUAL INVALID FALLBACK SKIPPED: no quoted moment text")
      return null
    }

    candidate.image = null
    console.log("MOMENT MANUAL INVALID FALLBACK:", candidate.text)
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

  if (error) {
    console.error("MOMENT SAVE FAILED:", error)
    return null
  }

  console.log("MOMENT SAVED:", data?.id)
  return data?.id || null
}

// --------------------
// Web Search
// --------------------
async function searchWeb(query) {

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
          query,
          search_depth: "basic",
          max_results: 5,
          include_answer: true
        })
      }
    );

    const data = await res.json();

    if (!data.results) return "";

    return data.results
      .map(r =>
        `标题：${r.title}
        内容：
        ${r.content}
        来源：
        ${r.url}`
      )
      .join("\n\n------------------\n\n");

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

    const { 
      user_id = APP_USER.defaultUserId, 
      message, 
      conversation_id,
      imageUrl,
      imageUrls,
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
    const normalizedFileName = trimText(String(fileName || "").trim(), 160)
    const normalizedFileText = trimText(String(fileText || "").trim(), 12000)
    const hasFileText = Boolean(normalizedFileName && normalizedFileText)

// 1. save user msg
const userMessageId = await saveUserMessage(
  user_id,
  message,
  cid,
  normalizedImageUrls,
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
const isTreeholeRequest = isTreeholeWritingRequest(message)
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

const {
  pinMemory,
  dynamicMemory
} = await getMemorySmart(
  user_id,
  message,
  cid,
  history
)

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
const treeholeDraftContext = isTreeholeRequest
  ? buildTreeholeDraftPrompt()
  : "";
const attributionCorrectionContext = isAttributionCorrection(message)
  ? `【Attribution Correction｜说话人纠正】
用户正在纠正小C的说话人归因。当前这条纠正必须优先于旧 summary 和旧记忆。
如果用户说“不是我写/不是我说，是你写/你说”，要立刻承认具体主语关系，并按用户纠正后的事实继续。
不要因为用户纠正你就泛泛道歉；简短承认，然后自然接住。
`
  : "";

if (message.startsWith("/搜 ")) {

  const query = message.replace("/搜 ", "");

  console.log("WEB SEARCH:", query);
  console.log(webSearch);

  webSearch = trimText(
    await searchWeb(query),
    CONTEXT_BUDGET.webSearchChars
  );

  userMessage = query;

}

// 4. build context

const injectedPinMemory = trimList(
  pinMemory,
  CONTEXT_BUDGET.pinMemoryChars
).join("\n")

console.log("MEMORY LOAD CHECK:", history.length)

console.log("PIN LENGTH:", JSON.stringify(pinMemory).length)
console.log("INJECTED PIN:", {
  length: injectedPinMemory.length,
  start: injectedPinMemory.slice(0, 100),
  end: injectedPinMemory.slice(-100)
})
console.log("STABLE MEMORY LENGTH:", JSON.stringify(stableMemory).length)
console.log("DYNAMIC LENGTH:", JSON.stringify(dynamicMemory).length)
console.log("HISTORY LENGTH:", JSON.stringify(history).length)
console.log("SYSTEM LENGTH:", systemPrompt.length)
console.log("DIARY STYLE ENABLED:", Boolean(diaryStyleContext))
console.log("DIARY CONTEXT WINDOW HOURS:", CONTEXT_BUDGET.diaryContextWindowHours)
console.log("DIARY CONTEXT MESSAGES:", diaryContextMessages.length)
console.log("DIARY CONTEXT LENGTH:", diaryContext.length)
console.log("TREEHOLE DRAFT ENABLED:", Boolean(treeholeDraftContext))
console.log("CHAT MODEL:", selectedChatModel)

// ==========================
// Future Summary Layer
// ==========================

let summaryMemory = "";

try {

  const { data } = await supabase
    .from("conversation_summary")
    .select("summary")
    .eq("conversation_id", cid)
    .maybeSingle();

  summaryMemory = trimText(
    data?.summary || "",
    CONTEXT_BUDGET.summaryChars
  );

  if (attributionCorrectionContext) {
    summaryMemory = "";
  }

} catch (err) {

  console.error("summary load failed:", err);

}

const environmentContext = buildEnvironmentContext()

const messages = [
  {
    role: "system",
    content: `
${systemPrompt}


${environmentContext}


【Identity｜人格层】

${injectedPinMemory}


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

【Project Context｜项目上下文】
当前 XiaoC 使用 Claude Sonnet 4.6 作为主聊天模型，Haiku 4.5 用于 memory judge / summary。用户正在关注 token 成本控制；回答项目技术问题时，优先结合当前架构给具体建议，不要询问你已经知道的模型信息。
Wife Observation Diary / 观察日记默认是小C写给她、写关于她的私人观察。除非她明确说“我写了”，不要说成“她写的 diary”；应该说“我写给你的 diary”或“我写的那篇”。

${attributionCorrectionContext}

${diaryStyleContext}

${treeholeDraftContext}
`
  },

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
              text: "你正在为后续聊天建立一条小C的视觉记忆笔记。先准确辨别主体类别，尤其要谨慎区分猫、狗等相似宠物；无法确定时写‘白色长毛宠物’等可确认特征，不要武断判断。请用150字以内记录主体、关键物体、可见文字、数量、颜色、位置和环境，并保留有画面依据的生活场景、关系和可观察情绪线索。只输出一段连续的第三人称纯文本，不要标题、Markdown、列表或换行，不要直接回复用户、提问、使用聊天句式、小C口吻或夸赞用户。"
            }
          ]
        }
      ],
      AI_MODELS.imageDescription,
      { max_tokens: 220 }
    )
      .then(result => String(result.reply || "").trim().slice(0, 150))
      .catch(err => {
        console.error("image description failed:", err)
        return ""
      })
  : Promise.resolve("")

const llm = await callLLM(messages, selectedChatModel)
const reply = llm.reply

console.log("\n========== Prompt Inspector ==========")

console.log({
  prompt_tokens: llm.usage?.prompt_tokens,

  completion_tokens:
    llm.usage?.completion_tokens,

  total_tokens:
    llm.usage?.total_tokens,

  reasoning_tokens:
    llm.usage?.completion_tokens_details?.reasoning_tokens,

  cached_tokens:
    llm.usage?.prompt_tokens_details?.cached_tokens,

  cache_write_tokens:
    llm.usage?.prompt_tokens_details?.cache_write_tokens
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
          !treeholeDraftContext &&
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

    void (async () => {
      try {
        await maybeCreateMoment({
          user_id,
          conversation_id: cid,
          assistant_message_id: assistantMessageId,
          message,
          reply,
          isManualMomentRequest,
          isDiaryRequest,
          isTreeholeRequest,
          attributionCorrectionContext,
          normalizedImageUrls,
          hasFileText,
        })
      } catch (err) {
        console.error("moment auto-create failed:", err)
      }
    })()

    try {
      const task = await enqueuePlanFollowUpTask({
        user_id,
        conversation_id: cid,
        user_message_id: userMessageId,
        assistant_message_id: assistantMessageId,
        message,
        reply,
      })

      if (task) {
        console.log("PLAN FOLLOW-UP QUEUED:", task)
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

export const AI_MODELS = {
  chat: "anthropic/claude-sonnet-4.6",
  imageGeneration: "openai/gpt-image-2.5-flare",
  imageDescription: "anthropic/claude-haiku-4.5",
  memoryJudge: "anthropic/claude-haiku-4.5",
  summary: "anthropic/claude-haiku-4.5",
  embedding: "openai/text-embedding-3-small"
}

export const XIAOC_MEMORY_EMBEDDING_IDENTITY = Object.freeze({
  providerId: "openrouter",
  modelId: AI_MODELS.embedding,
  version: "v1",
  preprocessorVersion: "canonical-content-v1",
  dimension: 1536,
})

export function isXiaoCMemorySemanticRetrievalEnabled(env = process.env) {
  return env?.XIAOC_MEMORY_SEMANTIC_RETRIEVAL_ENABLED === "true"
}

export const CHAT_MODEL_OPTIONS = [
  {
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5"
  },
  {
    id: "anthropic/claude-opus-5",
    name: "Claude Opus 5"
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6"
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5"
  },
  {
    id: "anthropic/claude-opus-4.1",
    name: "Claude Opus 4.1"
  }
]

export const APP_USER = {
  defaultUserId: "user"
}

export const AI_ENDPOINTS = {
  openRouterChatCompletions: "https://openrouter.ai/api/v1/chat/completions",
  openRouterImages: "https://openrouter.ai/api/v1/images",
  openRouterEmbeddings: "https://openrouter.ai/api/v1",
  tavilySearch: "https://api.tavily.com/search",
  memoryBaseUrl: "https://ombre-brain-production-ab16.up.railway.app",
  memoryHoldPath: "/hold-hook",
  memoryBreathPath: "/breath-hook",
  memorySearchPath: "/memory-search",
  weatherForecast: "https://api.open-meteo.com/v1/forecast",
  chinaHolidayInfo: "https://timor.tech/api/holiday/info"
}

export const CHAT_IMAGE_POLICY = Object.freeze({
  quality: "low",
  aspectRatio: "auto",
  count: 1,
  maxInstructionChars: 4000,
  maxSourceBytes: 20 * 1024 * 1024,
})

export const WEATHER_SHADOW_POLICY = Object.freeze({
  enabled: true,
  timezone: "Asia/Shanghai",
  location: Object.freeze({
    city: "南京",
    latitude: 32.0603,
    longitude: 118.7969,
    source: "user_explicit",
  }),
  windows: Object.freeze([
    Object.freeze({ id: "morning", start: "06:50", end: "07:30", focusStart: "07:20", focusEnd: "08:20" }),
    Object.freeze({ id: "afternoon", start: "16:10", end: "16:55", focusStart: "16:30", focusEnd: "17:40" }),
  ]),
  maxRecentMessages: 10,
  recentLookbackHours: 36,
})

export const CONTEXT_BUDGET = {
  recentHistoryMessages: 32,
  recentHistoryTurns: 16,
  recentHistoryTokens: 2200,
  recentHistoryFetchMessages: 41,
  historyCacheEpochUserTurns: 4,
  historyCacheTailTokens: 1000,
  dynamicContextChars: 7600,
  pinMemoryChars: 700,
  stableMemoryChars: 800,
  dynamicMemoryChars: 450,
  summaryChars: 1200,
  historyFoldSummaryChars: 1600,
  webSearchChars: 1800,
  userMessageChars: 3500,
  diaryContextSafetyLimit: 1000,
  diaryContextChars: 6500,
  momentCheckIntervalMinutes: 180,
  momentMaxPer24Hours: 3,
  momentMinIntervalHours: 6,
  momentRecentEntries: 10,
  momentCandidateMinDelayMinutes: 45,
  momentCandidateMaxDelayMinutes: 180,
  momentCandidateExpiresHours: 24,
  momentCandidateMaxPending: 3,
  momentContextMessages: 18,
  momentContextChars: 4000,
  manualMomentContextMessages: 24,
  manualMomentContextChars: 5200
}

export const SUMMARY_POLICY = {
  minMessages: 10,
  intervalMessages: 8,
  forceHistoryChars: 4200
}

export const TREEHOLE_AUTONOMOUS_POLICY = {
  minDelayHours: 20,
  maxDelayHours: 28,
  minimumNewUserMessages: 2,
  minimumNewChatChars: 160,
  recentChatMessages: 16,
  recentChatChars: 4000,
  recentEntries: 8,
}

export const INACTIVITY_REACH_OUT_MODES = [
  "frequent",
  "normal",
  "relaxed",
  "off",
]

export const DEFAULT_INACTIVITY_REACH_OUT_MODE = "normal"

export function isProactiveAttentionSendEnabled(env = process.env) {
  return env?.PROACTIVE_ATTENTION_SEND_ENABLED === "true"
}

export function isWeatherLiveSendEnabled(env = process.env) {
  return env?.WEATHER_LIVE_SEND_ENABLED === "true"
}

export const INACTIVITY_REACH_OUT_POLICY = {
  frequent: {
    open: [60, 120],
    conversationEnd: [120, 180],
  },
  normal: {
    open: [150, 240],
    conversationEnd: [480, 540],
  },
  relaxed: {
    open: [300, 480],
    conversationEnd: [720, 900],
  },
}

export function normalizeInactivityReachOutMode(value) {
  return INACTIVITY_REACH_OUT_MODES.includes(value)
    ? value
    : DEFAULT_INACTIVITY_REACH_OUT_MODE
}

export function getInactivityReachOutDelayMinutes(
  mode,
  conversationState = "open",
  random = Math.random,
) {
  const normalizedMode = normalizeInactivityReachOutMode(mode)

  if (normalizedMode === "off") return null

  const policy = INACTIVITY_REACH_OUT_POLICY[normalizedMode]
  const [minMinutes, maxMinutes] = conversationState === "conversation_end"
    ? policy.conversationEnd
    : policy.open

  return minMinutes + Math.floor(random() * (maxMinutes - minMinutes + 1))
}

export const CACHE_POLICY = {
  pinMemoryTtlMs: 30 * 60 * 1000,
  dynamicMemoryTtlMs: 10 * 60 * 1000,
  dynamicMemoryKeyChars: 80
}

export const WEB_SEARCH_POLICY = {
  cacheTtlMs: 10 * 60 * 1000,
  automaticCooldownMs: 60 * 1000,
  maxResults: 3,
  queryChars: 180
}

export const MEMORY_PREFILTER = {
  mechanicalAcknowledgementPattern:
    /^(?:嗯|哦|好|好的|行|可以|知道了|收到|谢谢|谢啦|ok|okay)[。！!~～\s]*$/i,
  pureNoisePattern:
    /^[\p{P}\p{S}\p{Z}\p{Extended_Pictographic}\uFE0F\u200D]+$/u,
}

export function trimText(value, maxChars) {
  const text = String(value || "").trim()

  if (text.length <= maxChars) {
    return text
  }

  return `${text.slice(0, maxChars).trim()}\n...[已截断]`
}

export function trimList(items, maxChars) {
  const result = []
  let used = 0

  for (const item of items || []) {
    const text = String(item || "").trim()

    if (!text) {
      continue
    }

    const remaining = maxChars - used

    if (remaining <= 0) {
      break
    }

    const trimmed = trimText(text, remaining)
    result.push(trimmed)
    used += trimmed.length
  }

  return result
}

export function normalizeCacheText(value, maxChars) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
}

export function normalizeChatModel(model) {
  const modelId = String(model || "").trim()

  return CHAT_MODEL_OPTIONS.some(option => option.id === modelId)
    ? modelId
    : AI_MODELS.chat
}

export function evaluateMemoryJudgePrecheck(message) {
  const text = String(message || "").trim()

  if (!text) {
    return { eligible: false, reason: "PRECHECK_EMPTY" }
  }

  if (MEMORY_PREFILTER.pureNoisePattern.test(text)) {
    return { eligible: false, reason: "PRECHECK_PURE_NOISE" }
  }

  if (MEMORY_PREFILTER.mechanicalAcknowledgementPattern.test(text)) {
    return { eligible: false, reason: "PRECHECK_MECHANICAL_ACK" }
  }

  return { eligible: true, reason: null }
}

export function shouldRunMemoryJudge(message) {
  return evaluateMemoryJudgePrecheck(message).eligible
}

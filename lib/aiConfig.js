export const AI_MODELS = {
  chat: "anthropic/claude-sonnet-4.6",
  memoryJudge: "anthropic/claude-haiku-4.5",
  summary: "anthropic/claude-haiku-4.5"
}

export const CHAT_MODEL_OPTIONS = [
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
  tavilySearch: "https://api.tavily.com/search",
  memoryBaseUrl: "https://ombre-brain-production-ab16.up.railway.app",
  memoryHoldPath: "/hold-hook",
  memoryBreathPath: "/breath-hook",
  memorySearchPath: "/memory-search"
}

export const CONTEXT_BUDGET = {
  recentHistoryMessages: 6,
  pinMemoryChars: 700,
  stableMemoryChars: 800,
  dynamicMemoryChars: 450,
  summaryChars: 700,
  webSearchChars: 1800,
  userMessageChars: 3500
}

export const SUMMARY_POLICY = {
  minMessages: 14,
  intervalMessages: 10,
  forceHistoryChars: 4200
}

export const CACHE_POLICY = {
  pinMemoryTtlMs: 30 * 60 * 1000,
  dynamicMemoryTtlMs: 10 * 60 * 1000,
  dynamicMemoryKeyChars: 80
}

export const MEMORY_PREFILTER = {
  minMeaningfulChars: 12,
  forceMemoryIntentPattern:
    /记一下|记住|保存一下|别忘了|以后提醒我|这个很重要|要记得/,
  skipPattern:
    /^(你好|hi|hello|哈喽|在吗|嗯|哦|啊|哈哈|谢谢|谢啦|好的|好|ok|OK|晚安|早安|拜拜|再见)[。！!~\s]*$/
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

export function shouldRunMemoryJudge(message) {
  const text = String(message || "").trim()

  if (!text) {
    return false
  }

  if (MEMORY_PREFILTER.forceMemoryIntentPattern.test(text)) {
    return true
  }

  if (MEMORY_PREFILTER.skipPattern.test(text)) {
    return false
  }

  if (text.length < MEMORY_PREFILTER.minMeaningfulChars) {
    return false
  }

  return true
}

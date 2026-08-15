export const AI_MODELS = {
  chat: "anthropic/claude-sonnet-4.6",
  imageDescription: "anthropic/claude-haiku-4.5",
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
  recentHistoryMessages: 10,
  pinMemoryChars: 700,
  stableMemoryChars: 800,
  dynamicMemoryChars: 450,
  summaryChars: 1200,
  webSearchChars: 1800,
  userMessageChars: 3500,
  diaryContextMessages: 36,
  diaryContextWindowHours: 24,
  diaryContextChars: 6500,
  momentCheckIntervalUserMessages: 8,
  momentMaxPer24Hours: 2,
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
  recentChatMessages: 16,
  recentChatChars: 4000,
  recentEntries: 8,
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
  minMeaningfulChars: 12,
  forceMemoryIntentPattern:
    /记一下|记住|保存一下|别忘了|以后提醒我|这个很重要|要记得/,
  personalSignalPattern:
    /我(喜欢|不喜欢|希望|想要|需要|害怕|担心|在意|介意|习惯|容易|总是|经常|会因为|不敢|希望你|想让你|需要你)|你以后|以后你|叫我|称呼我|对我说|跟我说|陪我|安慰我|不要.*附和|真实.*反馈|不要.*道歉|不用.*道歉|老婆|宝宝|小天使|榴莲|小狗|家人|朋友|关系|记得我们|我们的/,
  projectOnlyPattern:
    /UI|界面|按钮|气泡|侧边栏|字体|颜色|图标|布局|留白|模块|设置页|用户栏|前端|后端|API|token|OpenRouter|Vercel|Railway|Expo|EAS|GitHub|push|pull|部署|日志|报错|bug|测试|代码|prompt|模型选择/,
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

  if (MEMORY_PREFILTER.personalSignalPattern.test(text)) {
    return true
  }

  if (MEMORY_PREFILTER.projectOnlyPattern.test(text)) {
    return false
  }

  return false
}

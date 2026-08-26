const FUTURE_INTENT_PATTERN =
  /(?:打算|准备|计划|明天|后天|下周|周[一二三四五六日天]|星期[一二三四五六日天]|等会儿?要|一会儿?要|稍后要|之后再|下班后|过会儿?)/
const STARTED_EVENT_PATTERN =
  /(?:正在|已经开始|刚开始|才开始|开始做|开始弄|着手|进行中|做到一半|还在做|还在弄)/
const COMPLETED_EVENT_PATTERN =
  /(?:已经完成|已经做完|已经弄好|做完了|弄好了|结束了|考完了|完成了|结果出来|出结果了)/
const PROGRESS_OR_RESULT_PATTERN =
  /(?:怎么样了|做得怎么样|弄得怎么样|进展|做到哪|完成了吗|做完了吗|弄好了吗|结束了吗|结果怎么样|出结果了吗|顺利吗|累不累|还在(?:做|弄|忙).{0,8}吗)/

function formatShanghaiDateTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "时间未知"

  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const get = type => parts.find(part => part.type === type)?.value || ""

  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`
}

function getAssistantSourceLabel(message) {
  if (message?.role !== "assistant" || !message?.metadata?.proactive) return ""

  const type = String(message.metadata.proactiveType || "proactive").trim()
  return `（小C主动发送${type ? `，来源 ${type}` : ""}）`
}

export function formatTimestampedConversationMessage(message, content) {
  const speaker = message?.role === "user" ? "她" : "小C"
  const sourceLabel = getAssistantSourceLabel(message)
  return `[${formatShanghaiDateTime(message?.created_at)} Asia/Shanghai] ${speaker}${sourceLabel}：${content}`
}

export function formatTimedInactivityMessages(messages, trimContent) {
  return (messages || []).map(item => {
    const content = trimContent
      ? trimContent(item.content, 300)
      : String(item.content || "").slice(0, 300)

    return formatTimestampedConversationMessage(item, content)
  }).join("\n")
}

const SELF_HISTORY_ACTION_PATTERN = /(?:说|讲|提|问|发|回|告诉|做)/
const SELF_HISTORY_TIME_PATTERN = /(?:刚才|之前|后来|昨晚|昨天|那天|早上|上午|中午|下午|晚上)/
const NEGATED_SELF_HISTORY_PATTERN =
  /(?:我|小C|本来|其实|后来|怎么).{0,24}(?:没|没有|没能|忘了).{0,10}(?:说|讲|提|问|发|回|告诉|做)|(?:想|本来|其实).{0,16}(?:说|讲|提|问|发|回|告诉|做).{0,20}(?:后来|怎么).{0,8}(?:没|没有)/
const POSITIVE_SELF_HISTORY_PATTERN =
  /(?:我|小C).{0,12}(?:刚才|之前|后来|昨晚|昨天|那天|早上|上午|中午|下午|晚上).{0,16}(?:说|讲|提|问|发|回|告诉|做)(?:过|了)?/
const HISTORY_ANCHOR_STOPWORDS = new Set([
  "其实", "本来", "后来", "怎么", "就是", "跟你", "给你", "想跟你", "想给你",
  "没有", "没说", "说过", "做过", "问过", "告诉", "昨晚", "昨天", "之前", "刚才",
])

function extractHistoryAnchors(value) {
  const text = String(value || "")
  const anchors = new Set()

  for (const match of text.matchAll(/[“"']([^”"']{2,20})[”"']/g)) {
    anchors.add(match[1].trim())
  }

  for (const match of text.matchAll(/(?:说|讲|提|问|发|回|告诉)(?:过|了)?(?:一句|一声)?[：:\s]*([\u4e00-\u9fff]{2,12})/g)) {
    const phrase = match[1]
      .replace(/(?:的|呢|啊|呀|嘛|吧|了)+$/g, "")
      .trim()
    if (phrase.length >= 2 && !HISTORY_ANCHOR_STOPWORDS.has(phrase)) anchors.add(phrase)
  }

  return [...anchors].filter(anchor =>
    anchor.length >= 2 &&
    !HISTORY_ANCHOR_STOPWORDS.has(anchor) &&
    !SELF_HISTORY_TIME_PATTERN.test(anchor)
  )
}

export function validateProactiveHistoricalClaims(message, messages) {
  const output = String(message || "").trim()
  const anchors = extractHistoryAnchors(output)
  const assistantHistory = (messages || [])
    .filter(item => item.role === "assistant")
    .map(item => String(item.content || ""))
    .join("\n")
  const evidenceAnchors = anchors.filter(anchor => assistantHistory.includes(anchor))
  const hasNegativeClaim = NEGATED_SELF_HISTORY_PATTERN.test(output)
  const hasPositivePastClaim =
    POSITIVE_SELF_HISTORY_PATTERN.test(output) ||
    (SELF_HISTORY_TIME_PATTERN.test(output) && SELF_HISTORY_ACTION_PATTERN.test(output) && /(?:我|小C)/.test(output))

  if (hasNegativeClaim && evidenceAnchors.length > 0) {
    return { valid: false, reason: "contradicts_recorded_assistant_action", anchors: evidenceAnchors }
  }

  if (hasPositivePastClaim && anchors.length > 0 && evidenceAnchors.length === 0) {
    return { valid: false, reason: "unsupported_assistant_history_claim", anchors }
  }

  return { valid: true, reason: null, anchors }
}

export function getInactivityEventEvidence(messages) {
  const userMessages = (messages || [])
    .filter(item => item.role === "user")
    .map(item => String(item.content || ""))
  let latestFutureIntentIndex = -1

  userMessages.forEach((content, index) => {
    if (FUTURE_INTENT_PATTERN.test(content)) latestFutureIntentIndex = index
  })

  const relevantMessages = latestFutureIntentIndex >= 0
    ? userMessages.slice(latestFutureIntentIndex)
    : userMessages
  const relevantText = relevantMessages.join("\n")
  const hasStartedEvidence = STARTED_EVENT_PATTERN.test(relevantText)
  const hasCompletedEvidence = COMPLETED_EVENT_PATTERN.test(relevantText)

  return {
    hasFutureIntent: latestFutureIntentIndex >= 0,
    hasStartedEvidence,
    hasCompletedEvidence,
    futureIntentStillUnconfirmed:
      latestFutureIntentIndex >= 0 && !hasStartedEvidence && !hasCompletedEvidence,
  }
}

export function isTemporallyUnsupportedReachOut(message, messages) {
  if (!PROGRESS_OR_RESULT_PATTERN.test(String(message || ""))) return false

  const evidence = getInactivityEventEvidence(messages)
  return evidence.futureIntentStillUnconfirmed ||
    (!evidence.hasStartedEvidence && !evidence.hasCompletedEvidence)
}

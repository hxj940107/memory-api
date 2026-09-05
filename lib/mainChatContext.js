const SHANGHAI_TIMEZONE = "Asia/Shanghai"

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：,.!?;:'"“”‘’（）()\[\]【】\-_]/g, "")
}

function grams(value, size = 3) {
  const text = normalizeText(value)
  const result = new Set()
  for (let index = 0; index <= text.length - size; index += 1) {
    result.add(text.slice(index, index + size))
  }
  return result
}

function hasSharedPhrase(left, right, minChars = 4) {
  const genericPhrases = new Set([
    "今天早上", "今天上午", "今天中午", "今天下午", "今天晚上",
    "明天早上", "明天上午", "明天中午", "明天下午", "明天晚上",
    "小C主动", "她今天说", "她刚刚说",
  ])
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  for (let index = 0; index <= shorter.length - minChars; index += 1) {
    const phrase = shorter.slice(index, index + minChars)
    if (!genericPhrases.has(phrase) && longer.includes(phrase)) return true
  }
  return false
}

export function isContextuallyDuplicate(left, right) {
  const a = normalizeText(left)
  const b = normalizeText(right)
  if (Math.min(a.length, b.length) < 6) return false
  if (a.includes(b) || b.includes(a)) return true
  if (hasSharedPhrase(a, b)) return true

  const aGrams = grams(a)
  const bGrams = grams(b)
  if (!aGrams.size || !bGrams.size) return false
  let overlap = 0
  for (const gram of aGrams) {
    if (bGrams.has(gram)) overlap += 1
  }
  return overlap / Math.min(aGrams.size, bGrams.size) >= 0.58
}

function formatShanghaiTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "unknown"
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: SHANGHAI_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date)
  const part = type => parts.find(item => item.type === type)?.value || ""
  return `${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`
}

export function buildRecentMessageLedger(messages) {
  const rows = (messages || []).filter(item => item?.id && item?.created_at)
  if (!rows.length) return ""

  return `【Recent Message Ledger｜Asia/Shanghai】
${rows.map((item, index) => {
    const proactive = item.metadata?.proactive === true
    const proactiveType = item.metadata?.proactiveType
      || item.metadata?.proactive_type
      || item.metadata?.type
      || null
    const specialSource = proactive
      ? ` proactive${proactiveType ? `/${proactiveType}` : ""}`
      : ""
    return `m${index + 1} ${item.role} ${formatShanghaiTime(item.created_at)}${specialSource}`
  }).join("\n")}`
}

export function buildOptionalContextSection(title, content) {
  const text = String(content || "").trim()
  return text ? `【${title}】\n\n${text}` : ""
}

export function joinContextBlocks(blocks) {
  return (blocks || [])
    .map(block => String(block || "").trim())
    .filter(Boolean)
    .join("\n\n")
}

export function buildHistoricalSummaryView(summary, recentMessages) {
  const text = String(summary || "").trim()
  if (!text) return ""
  const recentTexts = (recentMessages || [])
    .map(item => item?.content)
    .filter(Boolean)
  if (!recentTexts.length) return text

  const chunks = text
    .split(/(?<=。|！|？)|\n/)
    .map(item => item.trim())
    .filter(Boolean)
  const kept = chunks.filter(chunk => {
    if (/^【[^】]+】$/.test(chunk)) return true
    return !recentTexts.some(recent => isContextuallyDuplicate(chunk, recent))
  })
  return kept.join("\n").trim()
}

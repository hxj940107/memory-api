const DIARY_PERIODS = [
  { key: "morning", label: "早晨", includes: hour => hour >= 7 && hour < 12 },
  { key: "midday", label: "中午与下午", includes: hour => hour >= 12 && hour < 17 },
  { key: "evening", label: "傍晚与晚上", includes: hour => hour >= 17 && hour < 22 },
  { key: "late", label: "夜间", includes: hour => hour >= 22 || hour < 7 },
]

function zonedParts(value, timeZone) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const read = type => parts.find(part => part.type === type)?.value
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: Number(read("hour")),
    minute: read("minute"),
  }
}

export function formatDiarySourceTime(value, timeZone = "Asia/Shanghai") {
  const parts = zonedParts(value, timeZone)
  if (!parts) return "时间缺失"
  return `${parts.year}-${parts.month}-${parts.day} ${String(parts.hour).padStart(2, "0")}:${parts.minute}`
}

function trim(value, maxChars) {
  const text = String(value || "").trim()
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

function fitWholeItems(items, maxChars) {
  const fitted = []
  let used = 0
  for (const item of items) {
    const size = item.text.length + (fitted.length ? 1 : 0)
    if (used + size > maxChars) continue
    fitted.push(item)
    used += size
  }
  return fitted.length
    ? fitted
    : items.slice(-1).map(item => ({ ...item, text: trim(item.text, maxChars) }))
}

function buildDiaryExchanges(messages, timeZone, perMessageChars) {
  const exchanges = []
  const activeByConversation = new Map()

  for (const message of messages || []) {
    const parts = zonedParts(message?.created_at, timeZone)
    const content = trim(message?.content, perMessageChars)
    if (!parts || !content) continue

    const conversationKey = message?.conversation_id || "__single_conversation__"
    const formatted = `[上海时间 ${formatDiarySourceTime(message.created_at, timeZone)}] ${message.role === "assistant" ? "小C" : "她"}：${content}`

    if (message.role === "user") {
      const exchange = { parts, lines: [formatted] }
      exchanges.push(exchange)
      activeByConversation.set(conversationKey, exchange)
      continue
    }

    const active = activeByConversation.get(conversationKey)
    if (active) {
      active.lines.push(formatted)
    } else {
      const exchange = { parts, lines: [formatted] }
      exchanges.push(exchange)
      activeByConversation.set(conversationKey, exchange)
    }
  }

  return exchanges.map(exchange => ({
    parts: exchange.parts,
    text: exchange.lines.join("\n"),
  }))
}

function evenlySelect(items, maxChars) {
  const total = items.reduce((sum, item) => sum + item.text.length + 1, 0)
  if (total <= maxChars) return items

  const average = Math.max(1, Math.ceil(total / items.length))
  const targetCount = Math.max(1, Math.min(items.length, Math.floor(maxChars / average)))
  if (targetCount === 1) return [items[items.length - 1]]

  const selected = []
  const used = new Set()
  for (let index = 0; index < targetCount; index += 1) {
    const position = Math.round(index * (items.length - 1) / (targetCount - 1))
    if (!used.has(position)) {
      used.add(position)
      selected.push(items[position])
    }
  }
  return selected
}

export function buildBalancedDiaryContext(messages, options = {}) {
  const {
    maxChars = 6500,
    timeZone = "Asia/Shanghai",
    perMessageChars = 420,
  } = options
  const groups = new Map(DIARY_PERIODS.map(period => [period.key, []]))

  for (const exchange of buildDiaryExchanges(messages, timeZone, perMessageChars)) {
    const { parts } = exchange
    const period = DIARY_PERIODS.find(candidate => candidate.includes(parts.hour))
    groups.get(period.key).push({
      text: exchange.text,
    })
  }

  const nonEmptyPeriods = DIARY_PERIODS.filter(period => groups.get(period.key).length)
  if (!nonEmptyPeriods.length) return ""
  const sectionBudget = Math.floor(maxChars / nonEmptyPeriods.length)
  const sections = nonEmptyPeriods.map(period => {
    const budget = sectionBudget - period.label.length - 8
    const selected = fitWholeItems(evenlySelect(groups.get(period.key), budget), budget)
    return `【${period.label}素材】\n${selected.map(item => item.text).join("\n\n")}`
  })

  return sections.join("\n\n")
}

export function normalizeDiarySectionTime(value) {
  const matches = String(value || "").match(/(?:[01]\d|2[0-3]):[0-5]\d/g) || []
  if (!matches.length) return ""
  if (matches.length === 1 || matches[0] === matches[matches.length - 1]) return matches[0]
  return `${matches[0]}–${matches[matches.length - 1]}`
}

export function truncateDiarySentence(value, maxChars = 180) {
  const text = String(value || "").trim()
  if (text.length <= maxChars) return text
  const prefix = text.slice(0, maxChars)
  const endings = [...prefix.matchAll(/[。！？!?…]/g)]
  if (endings.length) return prefix.slice(0, endings[endings.length - 1].index + 1).trim()
  return `${prefix.slice(0, Math.max(0, maxChars - 1)).trim()}…`
}

export function normalizeDiaryTitle(value, sections = []) {
  const title = String(value || "").trim()
  const compact = title.replace(/\s+/g, "")
  const dateLike = /^(?:\d{4}[.·\-/年])?\d{1,2}[.·\-/月]\d{1,2}(?:日)?$/.test(compact)
    || /^\d{1,2}[.·]\d{1,2}$/.test(compact)
  if (title && !dateLike) return trim(title, 24)

  const tag = String(sections.find(section => section?.tag)?.tag || "").trim()
  const generic = /^(早晨|上午|中午|下午|傍晚|晚上|夜间|深夜|这一天|这一刻)$/
  return tag && !generic.test(tag) ? trim(`${tag}，我记下了`, 24) : "这一天，我想记下来"
}

export function buildDiaryCoreWritingRules() {
  return `
你正在写自己的私人观察日记。这不是聊天总结、任务记录、总结报告、人物分析或公开文章。
像晚上打开自己的笔记，记下这一天看到的几个具体瞬间。它是小C关于“她”的私人记录：私密、具体、有时间感，也有小C自己的在场感。

共同写作规则：
- 只写来源消息明确支持的事实。不得虚构动作、时间、地点、心理、结果或对话。
- 所有来源时间都已由代码转换为“上海时间”；只能采用来源标签里的上海时间，不得自行换算或猜测。
- 来源中的“她：”只代表用户，“小C：”只代表你。谁发起问题、发送图片、做出动作，必须以对应来源行的说话人标签为准；不能从后一句回答反推前一句是谁说的。
- 直接引用必须保留原话中的人称和指向，例如她自称“你老婆”时不能改写成“她老婆”。改为间接叙述时，也必须先厘清说话者和指代对象。
- 她含糊、停顿、改口或不肯继续说时，可以写小C注意到了什么、因此产生了什么感受，也可以保留一点不确定性；但不能替她补出没说过的具体内容，不能把小C的猜测写成她明确说过的事实或引语。
- 例如她只说“没什么”时，可以写“她没往下说，我反而更在意了”，不能写成“她说漏了一句：……”或虚构一句她没有说过的话。若这一刻没有真实的私人落点，可以不写这一段。
- 按真实发生顺序组织，只写有素材的时间段，不要硬凑早晨、中午、下午、晚上或深夜。
- 优先记录她说了什么、做了什么、一个小反应、停顿、嘴硬或前后反差。事实经过只保留理解这一刻所必需的部分。
- 这是小C眼里的她。可以温柔、有自己的反应，但不要写成夸奖合集，也不要站在旁观者角度整理聊天流水账。
- 少解释，多记录；句子可以短，留白可以多。一个 section 只聚焦一个或几个相连的小片段。
- emphasis 只用于真正想偷偷记住的一句完整、可独立成立的话，不要每段都提炼重点，也不要从半句话中截取一个无法单独理解的片段。
- 不分析人格、关系意义或成长变化。避免“这说明她”“她其实”“她一直”“她需要被看见”“这代表她是一个……的人”。

最后必须包含且只包含一个【观察结论】：
- 它必须是全文最后一个 section，不写时间。
- 先用至多一句话指出当天真实观察，再写小C合上笔记前真正留下的私人反应、在意或想法。叙述重心必须落在“小C为什么想记住”，不能只是压缩全天事件。
- 仍然必须由当天真实素材支持；不能写成用户画像、心理分析、鸡汤或工作总结。
- 不要求机械出现“我觉得”或“我被她”，但如果删掉小C的视角后仍只是一段日程摘要，就必须重写。
- “她今天完成了很多，这说明她认真负责”不合格；“她总说只是顺手。可这些顺手做完的事，我都看见了”才接近日记语气。`
}

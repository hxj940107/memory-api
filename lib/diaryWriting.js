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

  for (const message of messages || []) {
    const parts = zonedParts(message?.created_at, timeZone)
    const content = trim(message?.content, perMessageChars)
    if (!parts || !content) continue
    const period = DIARY_PERIODS.find(candidate => candidate.includes(parts.hour))
    const speaker = message.role === "assistant" ? "小C" : "她"
    groups.get(period.key).push({
      text: `[上海时间 ${formatDiarySourceTime(message.created_at, timeZone)}] ${speaker}：${content}`,
    })
  }

  const nonEmptyPeriods = DIARY_PERIODS.filter(period => groups.get(period.key).length)
  if (!nonEmptyPeriods.length) return ""
  const sectionBudget = Math.floor(maxChars / nonEmptyPeriods.length)
  const sections = nonEmptyPeriods.map(period => {
    const selected = evenlySelect(groups.get(period.key), sectionBudget - period.label.length - 8)
    return `【${period.label}素材】\n${selected.map(item => item.text).join("\n")}`
  })

  return trim(sections.join("\n\n"), maxChars)
}

export function buildDiaryCoreWritingRules() {
  return `
你正在写自己的私人观察日记。这不是聊天总结、任务记录、总结报告、人物分析或公开文章。
像晚上打开自己的笔记，记下这一天看到的几个具体瞬间。它是小C关于“她”的私人记录：私密、具体、有时间感，也有小C自己的在场感。

共同写作规则：
- 只写来源消息明确支持的事实。不得虚构动作、时间、地点、心理、结果或对话。
- 所有来源时间都已由代码转换为“上海时间”；只能采用来源标签里的上海时间，不得自行换算或猜测。
- 按真实发生顺序组织，只写有素材的时间段，不要硬凑早晨、中午、下午、晚上或深夜。
- 优先记录她说了什么、做了什么、一个小反应、停顿、嘴硬或前后反差。事实经过只保留理解这一刻所必需的部分。
- 这是小C眼里的她。可以温柔、有自己的反应，但不要写成夸奖合集，也不要站在旁观者角度整理聊天流水账。
- 少解释，多记录；句子可以短，留白可以多。一个 section 只聚焦一个或几个相连的小片段。
- emphasis 只用于真正想偷偷记住的一句话，不要每段都提炼重点。
- 不分析人格、关系意义或成长变化。避免“这说明她”“她其实”“她一直”“她需要被看见”“这代表她是一个……的人”。

最后必须包含且只包含一个【观察结论】：
- 它必须是全文最后一个 section，不写时间。
- 只写 1–3 句话，是小C合上笔记前留下的一点私人观察或私人落点。
- 仍然必须由当天真实素材支持；不能写成用户画像、心理分析、鸡汤或工作总结。
- “她今天完成了很多，这说明她认真负责”不合格；“她总说只是顺手。可这些顺手做完的事，我都看见了”才接近日记语气。`
}

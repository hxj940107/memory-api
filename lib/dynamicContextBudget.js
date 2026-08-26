const HISTORY_RECALL_PATTERN = /还记得|记不记得|以前|过去|之前|上次|那时候|曾经|回忆|我们聊过|当时/

export function estimateTextTokens(value) {
  const text = String(value || "")
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk / 1.5 + other / 4)
}

function groupLogicalTurns(messages) {
  const turns = []
  for (const message of messages || []) {
    if (message.role === "user" || !turns.length) {
      turns.push([message])
    } else {
      turns[turns.length - 1].push(message)
    }
  }
  return turns
}

export function selectTokenAwareRecentHistory(messages, {
  excludeMessageIds = [],
  tokenBudget = 2200,
  charBudget = Infinity,
  maxMessages = 32,
  maxTurns = 16,
} = {}) {
  const excluded = new Set(excludeMessageIds.filter(Boolean).map(String))
  const eligible = (messages || []).filter(message => (
    message?.id && !excluded.has(String(message.id))
  ))
  const turns = groupLogicalTurns(eligible)
  const selectedTurns = []
  let estimatedTokens = 0
  let messageCount = 0
  let usedChars = 0

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    const turnTokens = turn.reduce(
      (total, message) => total + estimateTextTokens(message.content) + 4,
      0
    )
    const turnChars = turn.reduce(
      (total, message) => total + String(message.content || "").length,
      0
    )
    if (selectedTurns.length >= maxTurns) break
    if (messageCount + turn.length > maxMessages) break
    if (estimatedTokens + turnTokens > tokenBudget) break
    if (usedChars + turnChars > charBudget) break
    selectedTurns.unshift(turn)
    estimatedTokens += turnTokens
    messageCount += turn.length
    usedChars += turnChars
  }

  return {
    messages: selectedTurns.flat(),
    estimatedTokens,
    tokenBudget,
    charBudget,
    usedChars,
    maxMessages,
    maxTurns,
    selectedMessages: messageCount,
    selectedTurns: selectedTurns.length,
  }
}

export function allocateDynamicContextBudget({
  currentMessage = "",
  activeItems = [],
  hasMemoryHit = false,
  expectsWebContext = false,
  totalChars = 7600,
} = {}) {
  const recallingHistory = HISTORY_RECALL_PATTERN.test(String(currentMessage || ""))
  const hasDurableActive = (activeItems || []).some(item => (
    ["waiting", "plan", "unresolved"].includes(item.kind)
    || item.status === "waiting"
  ))
  const mode = recallingHistory ? "history_recall" : hasDurableActive ? "active_continuity" : "casual"
  const weights = mode === "history_recall"
    ? { recent: 0.42, active: 0.10, summary: 0.20, memory: 0.18, ledger: 0.05, web: 0.05 }
    : mode === "active_continuity"
      ? { recent: 0.50, active: 0.18, summary: 0.10, memory: 0.10, ledger: 0.05, web: 0.07 }
      : { recent: 0.60, active: 0.09, summary: 0.08, memory: 0.08, ledger: 0.05, web: 0.10 }

  if (!activeItems?.length) {
    weights.recent += weights.active
    weights.active = 0
  }
  if (!hasMemoryHit && !recallingHistory) {
    const transfer = weights.memory / 2
    weights.recent += transfer
    weights.memory -= transfer
  }
  if (!expectsWebContext) {
    const transfer = weights.web / 2
    weights.recent += transfer
    weights.web -= transfer
  }

  const allocation = Object.fromEntries(
    Object.entries(weights).map(([key, weight]) => [key, Math.floor(totalChars * weight)])
  )
  return { mode, totalChars, ...allocation }
}

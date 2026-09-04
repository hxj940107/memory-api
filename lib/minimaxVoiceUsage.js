export function summarizeMiniMaxVoiceUsage(messages, since) {
  const sinceMs = new Date(since).getTime()
  const records = (messages || []).flatMap(message => {
    const voice = message?.metadata?.voice
    const createdAtMs = new Date(voice?.created_at || "").getTime()
    const usageCharacters = Number(voice?.usage_characters)
    const estimatedCostCny = Number(voice?.estimated_cost_cny)
    if (
      voice?.provider !== "minimax" ||
      !Number.isFinite(createdAtMs) ||
      voice?.usage_characters === null ||
      voice?.usage_characters === undefined ||
      voice?.estimated_cost_cny === null ||
      voice?.estimated_cost_cny === undefined ||
      !Number.isFinite(usageCharacters) ||
      !Number.isFinite(estimatedCostCny)
    ) return []
    return [{ createdAtMs, usageCharacters, estimatedCostCny }]
  }).filter(record => record.createdAtMs >= sinceMs)

  return {
    request_count: records.length,
    usage_characters: records.reduce((total, record) => total + record.usageCharacters, 0),
    estimated_cost_cny: records.reduce((total, record) => total + record.estimatedCostCny, 0),
  }
}

export function getShanghaiMonthStartIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now)
  const year = parts.find(part => part.type === "year")?.value
  const month = parts.find(part => part.type === "month")?.value
  return new Date(`${year}-${month}-01T00:00:00+08:00`).toISOString()
}

function optionalAmount(value) {
  if (value === null || value === undefined || value === "") return null
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : null
}

export function normalizeMiniMaxAccountBalance(payload) {
  if (Number(payload?.base_resp?.status_code) !== 0) return null
  const available = optionalAmount(payload?.available_amount)
  if (available === null) return null
  return {
    available_amount: available,
    cash_balance: optionalAmount(payload?.cash_balance),
    voucher_balance: optionalAmount(payload?.voucher_balance),
    credit_balance: optionalAmount(payload?.credit_balance),
    owed_amount: optionalAmount(payload?.owed_amount),
  }
}

export async function fetchMiniMaxAccountBalance({ env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = String(env.MINIMAX_API_KEY || "").trim()
  if (!apiKey) return null
  const baseUrl = String(env.MINIMAX_API_BASE_URL || "https://api.minimaxi.com")
    .trim()
    .replace(/\/+$/, "")
  const response = await fetchImpl(`${baseUrl}/account/query_balance`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) return null
  return normalizeMiniMaxAccountBalance(payload)
}

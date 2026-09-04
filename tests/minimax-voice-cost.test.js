import assert from "node:assert/strict"
import test from "node:test"

import {
  fetchMiniMaxAccountBalance,
  getShanghaiMonthStartIso,
  normalizeMiniMaxAccountBalance,
  summarizeMiniMaxVoiceUsage,
} from "../lib/minimaxVoiceUsage.js"

test("MiniMax pay-as-you-go balance keeps provider amounts separate", async () => {
  const payload = {
    available_amount: "14.11",
    cash_balance: "0.00",
    voucher_balance: "14.11",
    credit_balance: "0.00",
    owed_amount: "0.00",
    base_resp: { status_code: 0, status_msg: "success" },
  }
  assert.deepEqual(normalizeMiniMaxAccountBalance(payload), {
    available_amount: 14.11,
    cash_balance: 0,
    voucher_balance: 14.11,
    credit_balance: 0,
    owed_amount: 0,
  })

  let request
  const balance = await fetchMiniMaxAccountBalance({
    env: {
      MINIMAX_API_KEY: "server-secret",
      MINIMAX_API_BASE_URL: "https://api.minimaxi.com/",
    },
    fetchImpl: async (url, options) => {
      request = { url, options }
      return new Response(JSON.stringify(payload), { status: 200 })
    },
  })
  assert.equal(request.url, "https://api.minimaxi.com/account/query_balance")
  assert.equal(request.options.headers.Authorization, "Bearer server-secret")
  assert.equal(balance.available_amount, 14.11)
})

test("MiniMax voice usage only counts persisted provider-reported billing", () => {
  const since = "2026-09-01T00:00:00.000Z"
  const summary = summarizeMiniMaxVoiceUsage([
    { metadata: { voice: {
      provider: "minimax",
      created_at: "2026-09-02T00:00:00.000Z",
      usage_characters: 26,
      estimated_cost_cny: 0.0091,
    } } },
    { metadata: { voice: {
      provider: "minimax",
      created_at: "2026-09-03T00:00:00.000Z",
      usage_characters: 100,
      estimated_cost_cny: 0.035,
    } } },
    { metadata: { voice: {
      provider: "minimax",
      created_at: "2026-09-03T00:00:00.000Z",
    } } },
    { metadata: { voice: {
      provider: "other",
      created_at: "2026-09-03T00:00:00.000Z",
      usage_characters: 999,
      estimated_cost_cny: 9,
    } } },
  ], since)

  assert.deepEqual(summary, {
    request_count: 2,
    usage_characters: 126,
    estimated_cost_cny: 0.0441,
  })
})

test("MiniMax monthly cost follows the Shanghai calendar month", () => {
  assert.equal(
    getShanghaiMonthStartIso(new Date("2026-09-30T18:00:00.000Z")),
    "2026-09-30T16:00:00.000Z",
  )
})

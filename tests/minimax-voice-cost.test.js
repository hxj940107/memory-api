import assert from "node:assert/strict"
import test from "node:test"

import {
  getShanghaiMonthStartIso,
  summarizeMiniMaxVoiceUsage,
} from "../lib/minimaxVoiceUsage.js"

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

import assert from "node:assert/strict"
import test from "node:test"
import { classifyChatDeliveryFailure } from "../mobile/XiaoC/src/lib/chatDeliveryError.ts"

test("chat delivery failures produce distinct actionable notices", () => {
  const cases = [
    [new Error("Request timeout"), "timeout", true],
    [new TypeError("Network request failed"), "network", false],
    [Object.assign(new Error("Unauthorized"), { status: 401 }), "authentication", false],
    [Object.assign(new Error("Forbidden"), { status: 403 }), "account", false],
    [Object.assign(new Error("Busy"), { status: 429 }), "rate_limit", false],
    [Object.assign(new Error("Save failed"), { status: 503, code: "message_persistence_failed" }), "persistence", false],
    [Object.assign(new Error("Internal"), { status: 500 }), "service", false],
  ]

  const results = cases.map(([error]) => classifyChatDeliveryFailure(error))
  assert.deepEqual(
    results.map((result) => [result.kind, result.outcomeUnknown]),
    cases.map(([, kind, outcomeUnknown]) => [kind, outcomeUnknown]),
  )
  assert.equal(new Set(results.map((result) => result.notice)).size, cases.length)
})

test("persistence classification takes precedence over a generic server error", () => {
  const result = classifyChatDeliveryFailure({ status: 503, code: "message_persistence_failed" })
  assert.equal(result.kind, "persistence")
  assert.match(result.notice, /没有保存成功/)
  assert.equal(result.outcomeUnknown, false)
})

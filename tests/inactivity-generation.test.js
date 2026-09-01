import assert from "node:assert/strict"
import test from "node:test"

import {
  parseInactivityGeneration,
  validateInactivityGeneration,
} from "../lib/inactivityGeneration.js"

function decision(overrides = {}) {
  return parseInactivityGeneration(JSON.stringify({
    should_send: true,
    contact_motivation: "沉默了一阵，想自然靠近她",
    topic_state: "completed",
    temporal_fit: true,
    self_continuity: true,
    should_reference_topic: false,
    message: "过来陪你待一会儿。",
    ...overrides,
  }))
}

test("accepts a relationship reach-out without forcing a Recent topic", () => {
  const parsed = decision()
  assert.equal(parsed.shouldReferenceTopic, false)
  assert.deepEqual(validateInactivityGeneration(parsed), { valid: true, reason: null })
})

test("allows a technical topic when it has a real ongoing state", () => {
  const parsed = decision({
    topic_state: "ongoing",
    should_reference_topic: true,
    message: "后来那个方案想得怎么样了？",
  })
  assert.deepEqual(validateInactivityGeneration(parsed), { valid: true, reason: null })
})

test("rejects using a topic that the same judgment marked temporally unfit", () => {
  const parsed = decision({
    topic_state: "waiting",
    temporal_fit: false,
    should_reference_topic: true,
    message: "昨天那肉怎么样？",
  })
  assert.deepEqual(validateInactivityGeneration(parsed), {
    valid: false,
    reason: "referenced_topic_temporally_unfit",
  })
})

test("rejects a broken XiaoC identity perspective", () => {
  const parsed = decision({
    self_continuity: false,
    should_reference_topic: true,
    message: "看你们讨论得这么认真，我也想听听。",
  })
  assert.deepEqual(validateInactivityGeneration(parsed), {
    valid: false,
    reason: "self_continuity_failed",
  })
})

test("a natural model decline remains silent instead of using fixed fallback copy", () => {
  const parsed = decision({
    should_send: false,
    contact_motivation: "",
    message: "",
  })
  assert.deepEqual(validateInactivityGeneration(parsed), {
    valid: false,
    reason: "model_declined",
  })
})

test("malformed output is not repaired or converted into a fixed message", () => {
  const parsed = parseInactivityGeneration("不是 JSON")
  assert.equal(parsed.parseFailed, true)
  assert.deepEqual(validateInactivityGeneration(parsed), {
    valid: false,
    reason: "invalid_structured_output",
  })
})

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { validateUserMemoryProvenance } from "../lib/memoryJudge.js"

const current = {
  id: "user-current",
  role: "user",
  content: "我一直用纸质日历，这样可以吗？",
}

const proposed = (overrides = {}) => ({
  save: true,
  category: "relationship_preference",
  content: "她一直使用纸质日历。",
  source_role: "user",
  source_message_id: current.id,
  evidence_text: current.content,
  evidence_type: "question",
  ...overrides,
})

test("user-authored question evidence is not rejected by deterministic provenance validation", () => {
  const result = validateUserMemoryProvenance(proposed(), [current])

  assert.equal(result.save, true)
  assert.equal(result.provenance.evidence_type, "question")
})

test("an explicit user assertion keeps its exact source evidence", () => {
  const source = {
    id: "user-assertion",
    role: "user",
    content: "我最喜欢叫你老公",
  }
  const result = validateUserMemoryProvenance(proposed({
    source_message_id: source.id,
    evidence_text: source.content,
    evidence_type: "assertion",
  }), [source])

  assert.equal(result.save, true)
  assert.deepEqual(result.provenance, {
    source_role: "user",
    source_message_id: source.id,
    evidence_text: source.content,
    evidence_type: "assertion",
  })
})

test("an explicit user confirmation is valid evidence", () => {
  const source = {
    id: "user-confirmation",
    role: "user",
    content: "对，我就是喜欢你这么叫我",
  }
  const result = validateUserMemoryProvenance(proposed({
    content: "她确认喜欢我这样称呼她。",
    source_message_id: source.id,
    evidence_text: "我就是喜欢你这么叫我",
    evidence_type: "confirmation",
  }), [source])

  assert.equal(result.save, true)
  assert.equal(result.provenance.source_message_id, source.id)
})

test("assistant-only nickname evidence is rejected", () => {
  const result = validateUserMemoryProvenance(proposed({
    evidence_text: "小天使",
    evidence_type: "assertion",
  }), [current])

  assert.equal(result.save, false)
  assert.equal(result.reason, "evidence_not_exact_substring")
})

test("the immediately previous real user message can be the verified source", () => {
  const previous = {
    id: "user-previous",
    role: "user",
    content: "以后你可以多主动抱抱我",
  }
  const result = validateUserMemoryProvenance(proposed({
    content: "她希望我以后更主动地抱抱她。",
    source_message_id: previous.id,
    evidence_text: previous.content,
    evidence_type: "assertion",
  }), [previous, current])

  assert.equal(result.save, true)
  assert.equal(result.provenance.source_message_id, previous.id)
})

test("question punctuation alone does not invalidate otherwise exact evidence", () => {
  const result = validateUserMemoryProvenance(proposed({
    evidence_type: "assertion",
  }), [current])

  assert.equal(result.save, true)
})

test("unknown evidence types remain rejected with a predicate-specific reason", () => {
  const result = validateUserMemoryProvenance(proposed({ evidence_type: "invented_type" }), [current])
  assert.equal(result.save, false)
  assert.equal(result.reason, "evidence_type_invalid")
})

test("deterministic validation exposes the exact failing predicate", () => {
  const cases = [
    [{ source_role: "assistant" }, "source_role_invalid"],
    [{ source_message_id: "not-allowed" }, "source_message_not_allowed"],
    [{ evidence_text: "" }, "evidence_empty"],
    [{ evidence_text: "原消息中不存在的片段" }, "evidence_not_exact_substring"],
    [{ evidence_type: "invented_type" }, "evidence_type_invalid"],
    [{ category: "invented_category" }, "category_invalid"],
    [{ memory_type: "invented_memory_type" }, "memory_type_invalid"],
    [{ content: "" }, "canonical_empty"],
    [{ temporal: { event_time: "later", valid_from: null, valid_until: null } }, "temporal_format_invalid"],
    [{ temporal: {
      event_time: null,
      valid_from: "2027-02-02T09:00:00+08:00",
      valid_until: "2027-02-01T09:00:00+08:00",
    } }, "temporal_range_invalid"],
  ]
  for (const [override, reason] of cases) {
    const result = validateUserMemoryProvenance(proposed(override), [current])
    assert.equal(result.save, false, reason)
    assert.equal(result.reason, reason)
  }
})

test("invalid provenance stops before Ombre persistence and consolidation", () => {
  const chatSource = readFileSync("api/chat.js", "utf8")
  const memoryWrite = chatSource.slice(
    chatSource.indexOf("// 7. memory write"),
    chatSource.indexOf("maybeCreateMoment", chatSource.indexOf("// 7. memory write")),
  )

  assert.match(memoryWrite, /if \(judgeResult\.save\) \{[\s\S]*saveLongTermMemory/)
  assert.match(memoryWrite, /if \(judgeResult\.save\) \{[\s\S]*consolidateStableMemory/)
  assert.match(memoryWrite, /if \(judgeResult\.save\) \{[\s\S]*\} else \{[\s\S]*MEMORY SKIPPED/)
  assert.doesNotMatch(memoryWrite, /sourceMessageId: userMessageId/)
})

test("assistant sources and unknown user ids cannot pass provenance validation", () => {
  const assistant = {
    id: "assistant-1",
    role: "assistant",
    content: "我喜欢叫你小天使",
  }

  const assistantResult = validateUserMemoryProvenance(proposed({
    source_role: "assistant",
    source_message_id: assistant.id,
    evidence_text: assistant.content,
    evidence_type: "assertion",
  }), [assistant])
  assert.equal(assistantResult.save, false)
  assert.equal(assistantResult.reason, "source_role_invalid")

  const unknownResult = validateUserMemoryProvenance(proposed({
    source_message_id: "unknown-user",
    evidence_text: current.content,
    evidence_type: "assertion",
  }), [current])
  assert.equal(unknownResult.save, false)
  assert.equal(unknownResult.reason, "source_message_not_allowed")
})

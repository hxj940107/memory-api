import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { validateUserMemoryProvenance } from "../lib/memoryJudge.js"

const current = {
  id: "user-current",
  role: "user",
  content: "你最想听到我说的情话是？",
}

const proposed = (overrides = {}) => ({
  save: true,
  category: "relationship_preference",
  content: "她最喜欢叫我老公。",
  source_role: "user",
  source_message_id: current.id,
  evidence_text: current.content,
  evidence_type: "question",
  ...overrides,
})

test("a user question cannot turn the assistant answer into user memory", () => {
  const result = validateUserMemoryProvenance(proposed(), [current])

  assert.equal(result.save, false)
  assert.equal(result.reason, "invalid_source_provenance")
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
  assert.equal(result.reason, "invalid_source_provenance")
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

test("question-shaped evidence is rejected even when mislabeled as assertion", () => {
  const result = validateUserMemoryProvenance(proposed({
    evidence_type: "assertion",
  }), [current])

  assert.equal(result.save, false)
  assert.equal(result.reason, "invalid_source_provenance")
})

test("invalid provenance stops before Ombre persistence and consolidation", () => {
  const chatSource = readFileSync("api/chat.js", "utf8")
  const memoryWrite = chatSource.slice(
    chatSource.indexOf("// 7. memory write"),
    chatSource.indexOf("maybeCreateMoment", chatSource.indexOf("// 7. memory write")),
  )

  assert.match(memoryWrite, /if \(judgeResult\.save\) \{[\s\S]*saveLongTermMemory/)
  assert.match(memoryWrite, /if \(judgeResult\.save\) \{[\s\S]*consolidateStableMemory/)
  assert.match(memoryWrite, /else if \(judgeResult\.reason\)[\s\S]*MEMORY SKIPPED/)
  assert.doesNotMatch(memoryWrite, /sourceMessageId: userMessageId/)
})

test("assistant sources and unknown user ids cannot pass provenance validation", () => {
  const assistant = {
    id: "assistant-1",
    role: "assistant",
    content: "我喜欢叫你小天使",
  }

  assert.equal(validateUserMemoryProvenance(proposed({
    source_role: "assistant",
    source_message_id: assistant.id,
    evidence_text: assistant.content,
    evidence_type: "assertion",
  }), [assistant]).save, false)

  assert.equal(validateUserMemoryProvenance(proposed({
    source_message_id: "unknown-user",
    evidence_text: "我最喜欢叫你老公",
    evidence_type: "assertion",
  }), [current]).save, false)
})

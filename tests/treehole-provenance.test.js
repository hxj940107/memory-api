import assert from "node:assert/strict"
import test from "node:test"

import { validateTreeholeSourceEvidence } from "../lib/treeholeProvenance.js"

const sources = [
  { id: "user-1", role: "user", content: "喜欢大房子，你要送我吗" },
  { id: "assistant-1", role: "assistant", content: "送，先欠着" },
]

test("treehole evidence keeps the real speaker and exact source text", () => {
  const result = validateTreeholeSourceEvidence([
    {
      message_id: "user-1",
      source_role: "user",
      evidence_text: "喜欢大房子",
    },
    {
      message_id: "assistant-1",
      source_role: "assistant",
      evidence_text: "先欠着",
    },
  ], sources)

  assert.equal(result.valid, true)
  assert.deepEqual(result.sourceMessageIds, ["user-1", "assistant-1"])
})

test("assistant words cannot be relabeled as user evidence", () => {
  const result = validateTreeholeSourceEvidence([
    {
      message_id: "assistant-1",
      source_role: "user",
      evidence_text: "先欠着",
    },
  ], sources)

  assert.equal(result.valid, false)
  assert.equal(result.reason, "invalid_source_provenance")
})

test("invented or missing evidence cannot enter a treehole draft", () => {
  assert.equal(validateTreeholeSourceEvidence([], sources).valid, false)
  const invented = validateTreeholeSourceEvidence([
    {
      message_id: "user-1",
      source_role: "user",
      evidence_text: "喜欢大房子显得很庸俗",
    },
  ], sources)
  assert.equal(invented.valid, false)
  assert.equal(invented.reason, "evidence_not_in_source")
})

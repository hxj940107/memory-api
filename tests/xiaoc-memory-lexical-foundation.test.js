import assert from "node:assert/strict"
import test from "node:test"

import { normalizeLexicalText, scoreLexicalMatch } from "../lib/xiaocMemoryLexical.js"

test("Chinese exact and substring matches are explicit", () => {
  assert.equal(scoreLexicalMatch("长滩岛", "长滩岛").reasonCodes.includes("LEXICAL_EXACT_NORMALIZED"), true)
  assert.equal(scoreLexicalMatch("长滩岛", "她曾在国庆去过长滩岛旅行").reasonCodes.includes("LEXICAL_SUBSTRING"), true)
})

test("Chinese character n-grams recover related event wording", () => {
  const result = scoreLexicalMatch("国庆海岛旅行", "那次国庆期间的海岛旅行留下了很多照片")
  assert.equal(result.reasonCodes.includes("LEXICAL_CHARACTER_NGRAM"), true)
  assert.ok(result.score > 0.2)
})

test("ASCII case and full-width forms normalize consistently", () => {
  assert.equal(normalizeLexicalText("Ｂｏｒａｃａｙ ２０２６"), "boracay 2026")
  assert.equal(scoreLexicalMatch("BORACAY", "boracay").score, 1)
})

test("mixed Chinese English and numeric dates retain recall signals", () => {
  const mixed = scoreLexicalMatch("Boracay 行程", "她记录过 boracay 行程安排")
  assert.ok(mixed.score > 0.5)
  const dated = scoreLexicalMatch("2026 10 01", "计划日期是 2026-10-01")
  assert.equal(dated.reasonCodes.includes("LEXICAL_NUMERIC_ENTITY"), true)
})

test("emoji and punctuation form boundaries instead of gluing words", () => {
  assert.equal(normalizeLexicalText("猫😺咪，Boracay/Trip"), "猫 咪 boracay trip")
  assert.equal(scoreLexicalMatch("猫咪", "猫😺咪").reasonCodes.includes("LEXICAL_SUBSTRING"), false)
  assert.equal(scoreLexicalMatch("ab", "a-b").reasonCodes.includes("LEXICAL_SUBSTRING"), false)
})

test("short ambiguous queries cannot gain n-gram or substring score", () => {
  const result = scoreLexicalMatch("泳", "游泳装备")
  assert.equal(result.score, 0)
  assert.equal(result.reasonCodes.includes("LEXICAL_SHORT_QUERY_PROTECTED"), true)
})

test("irrelevant shared characters stay low", () => {
  const result = scoreLexicalMatch("今天工作很忙", "昨天去公园散步看花")
  assert.ok(result.score < 0.2)
})

import test from "node:test"
import assert from "node:assert/strict"

import { normalizeTreeholeReaction } from "../lib/treeholeReaction.js"

const fixedRandom = () => 0.5

test("repairs a Treehole reaction that has no opening emoji", async () => {
  assert.equal(
    normalizeTreeholeReaction("认错认得很快，意思没变 · ❤️ 9", [], fixedRandom),
    "🫢 认错认得很快，意思没变 · ❤️ 9"
  )
})

test("repairs a Treehole reaction that has no like count", async () => {
  assert.equal(
    normalizeTreeholeReaction("🧐 这句先记着", [], fixedRandom),
    "🧐 这句先记着 · ❤️ 25"
  )
})

test("keeps a valid Treehole reaction unchanged", async () => {
  const reaction = "🍵 又被我抓到了 · ❤️ 17"
  assert.equal(normalizeTreeholeReaction(reaction, [], fixedRandom), reaction)
})

test("repairs an empty Treehole reaction without using the legacy template", async () => {
  assert.equal(
    normalizeTreeholeReaction("", ["她说只改一个地方"], fixedRandom),
    "🫢 她说只改一个地方 · ❤️ 25"
  )
})

test("replaces the legacy fixed fallback before saving", async () => {
  assert.equal(
    normalizeTreeholeReaction("🌙 偷偷偏心 · ❤️ 1", ["今天又嘴硬了"], fixedRandom),
    "🫢 今天又嘴硬了 · ❤️ 25"
  )
})

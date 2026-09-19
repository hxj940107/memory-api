import assert from "node:assert/strict"
import test from "node:test"

import {
  assignMomentMaterialAliases,
  buildAlbumMomentMaterials,
  getAlbumNarrativePermission,
  getMessageNarrativePermission,
  selectRetainedMomentMaterials,
} from "../lib/momentMaterials.js"

function message(index, createdAt, overrides = {}) {
  return {
    id: `message-${index}`,
    conversation_id: "conversation-1",
    role: "user",
    content: `普通生活记录 ${index}`,
    created_at: createdAt,
    metadata: {},
    ...overrides,
  }
}

test("retained materials survive beyond the old eighteen-message window without model work", () => {
  const now = new Date("2026-09-06T12:00:00.000Z")
  const messages = [
    message("older-photo", "2026-09-05T02:00:00.000Z", {
      content: "午后出门走了一圈",
      metadata: { imageDescription: "一张白天街景照片" },
    }),
    ...Array.from({ length: 30 }, (_, index) => message(
      index,
      new Date(now.getTime() - index * 20 * 60 * 1000).toISOString(),
    )),
  ]

  const selected = selectRetainedMomentMaterials(messages, { now })
  assert.ok(selected.some(item => item.messageId === "message-older-photo"))
  assert.ok(selected.length <= 10)
})

test("message relationship semantics preserve explicit third parties", () => {
  assert.equal(getMessageNarrativePermission("我一个人去喝了杯咖啡"), "shared_life")
  assert.equal(getMessageNarrativePermission("我和同事一起吃饭"), "user_with_third_party")
})

test("album metadata separates shared-life, independent and uncertain permission", () => {
  assert.equal(getAlbumNarrativePermission({ relations: ["小天使"] }), "shared_life")
  assert.equal(getAlbumNarrativePermission({ relations: ["小C"] }), "xiaoc_independent")
  assert.equal(getAlbumNarrativePermission({ description: "城市里的天空" }), "xiaoc_independent")
  assert.equal(getAlbumNarrativePermission({}), "uncertain")
})

test("user photos are retained without forcing affection or relationship captions", () => {
  const selected = selectRetainedMomentMaterials([message("portrait", "2026-09-06T10:00:00.000Z", {
    content: "今天拍了一张自己的照片",
    metadata: { imageDescription: "用户本人的个人照片" },
  })], { now: new Date("2026-09-06T12:00:00.000Z") })

  assert.equal(selected.length, 1)
  assert.equal(selected[0].narrativePermission, "shared_life")
  assert.equal("motivation" in selected[0], false)
})

test("album selection uses existing metadata and produces compact aliases", () => {
  const materials = assignMomentMaterialAliases(buildAlbumMomentMaterials([
    { id: 9, description: "街角环境", relations: ["小C"], created_at: "2026-09-01T12:00:00Z" },
    { id: 10, relations: [], created_at: "2026-09-01T12:00:00Z" },
  ]))

  assert.equal(materials.length, 1)
  assert.equal(materials[0].alias, "a1")
  assert.equal(materials[0].sourceRef, "album-9")
})

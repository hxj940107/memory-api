import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { buildAlbumMomentMaterials, formatMomentMaterialsForPrompt, getAlbumNarrativePermission } from "../lib/momentMaterials.js"
import { MOMENT_NARRATION_CONTRACT } from "../lib/momentNarration.js"
import { buildAutonomousMomentPrompt } from "../lib/momentAutonomous.js"
import { resolveMomentImage } from "../lib/momentImageLibrary.js"

test("canonical album material preserves original facts and metadata without inferring shooting time", () => {
  const asset = { id: 42, description: "在虚构北港和朋友同行，单人出镜", category: "旅行", categories: ["自然"],
    relations: ["Mochi"], time_periods: ["evening"], weather: "sunny", created_at: "2026-01-01T12:00:00Z" }
  const material = buildAlbumMomentMaterials([asset])[0]
  assert.equal(material.description, asset.description)
  assert.deepEqual(material.categories, ["自然", "旅行"])
  assert.equal(material.narrativePermission, "user_with_third_party")
  assert.equal(material.observedAt, null)
  assert.equal(material.uploadedAt, asset.created_at)
  assert.equal(material.sourceRef, "album-42")
  const prompt = formatMomentMaterialsForPrompt([{ ...material, alias: material.sourceRef }])
  for (const field of [asset.description, "旅行", "Mochi", "evening", "sunny", "albumAssetId=42", "拍摄时间=unknown", "observed_at=unknown"]) assert.ok(prompt.includes(field))
  const image = JSON.parse(resolveMomentImage(material.sourceRef, "", [{ id: material.sourceRef, albumAssetId: material.albumAssetId }]))
  assert.equal(image.albumAssetId, material.albumAssetId)
})

test("single-person image does not remove default shared life; explicit participation stays in raw facts", () => {
  assert.equal(getAlbumNarrativePermission({ description: "单人出镜，虚构湖边留影" }), "shared_life")
  const solo = buildAlbumMomentMaterials([{ id: 43, description: "她独自旅行，在虚构湖边留影" }])[0]
  assert.ok(formatMomentMaterialsForPrompt([solo]).includes("她独自旅行"))
})

test("both builders receive shared narrator and fact contract; explicit route uses canonical mapper", () => {
  const prompt = buildAutonomousMomentPrompt({ materials: "fixture", environment: "fixture", recentMoments: "fixture" })
  assert.ok(prompt[0].content.endsWith(MOMENT_NARRATION_CONTRACT))
  const chat = readFileSync("api/chat.js", "utf8")
  assert.ok(chat.includes("momentMessages[0].content += MOMENT_NARRATION_CONTRACT"))
  assert.ok(chat.includes("buildAlbumMomentMaterials([selectedAlbum]"))
  assert.ok(chat.includes("createdAt: null, text: material.description"))
  assert.ok(chat.includes('candidate.image !== `album-${selectedAlbum.id}`'))
  for (const principle of ["叙述主体始终是小C", "我、你、我们", "默认共同经历", "明确排除信息优先", "单人出镜", "拍摄者", "不得冲突", "文案模板"]) assert.ok(MOMENT_NARRATION_CONTRACT.includes(principle))
  // Assertions cover builder inputs and constraints, not an uncalled model's semantic accuracy.
})

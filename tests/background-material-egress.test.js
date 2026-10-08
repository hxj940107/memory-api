import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"
import { readFileSync } from "node:fs"
import { queryFixture } from "./helpers/queryFixture.js"
import { normalizeAssistantOutput } from "../lib/assistantOutput.js"
import { CONTEXT_BUDGET, TREEHOLE_AUTONOMOUS_POLICY, WEATHER_SHADOW_POLICY, trimText } from "../lib/aiConfig.js"
import { MOMENT_MATERIAL_FETCH_LIMIT, MOMENT_MATERIAL_RETENTION_HOURS, assignMomentMaterialAliases, buildAlbumMomentMaterials, formatMomentMaterialsForPrompt, selectRetainedMomentMaterials } from "../lib/momentMaterials.js"
import { parseMomentCandidate, getMomentCandidateAdmission } from "../lib/momentPublishing.js"

const now = "2026-10-08T08:00:00.000Z"
class FixedDate extends Date {
  constructor(value) { super(value ?? now) }
  static now() { return Date.parse(now) }
}
const base = { user_id: "user", conversation_id: "c", created_at: "2026-10-08T07:00:00.000Z" }
const messages = [
  { ...base, id: "photo", role: "user", content: "今天一起去看了一片海", metadata: { imageDescription: "阳光下的海岸", imageUrl: "data:image/jpeg;base64," + "A".repeat(500_000), imageUrls: ["A".repeat(500_000)], userVoice: { transcription: "原语音内容" } } },
  { ...base, id: "reply", role: "assistant", content: [{ type: "thinking", text: "hidden" }, { type: "text", text: "这片海很安静。" }], metadata: { proactive: true, proactiveType: "inactivity_reach_out" } },
  { ...base, id: "legacy", role: "user", content: "明天打算去散步", metadata: null },
  { ...base, id: "voice", role: "user", content: "这条语音说我今天很开心", metadata: { userVoice: { transcription: "这条语音说我今天很开心" } } },
  { ...base, id: "other-owner", user_id: "other", role: "user", content: "must not leak", metadata: {} },
]
const source = readFileSync("api/memory.js", "utf8")
function body(name, next, legacy) {
  let section = source.slice(source.indexOf(`async function ${name}(`), source.indexOf(`${next}(`, source.indexOf(`async function ${name}(`)))
  if (legacy) section = section
    .replaceAll("imageDescription:metadata->imageDescription", "metadata")
    .replaceAll("message.imageDescription", "message.metadata?.imageDescription")
    .replace('.select("id,role,content,created_at")', '.select("id,role,content,created_at,metadata")')
  return section
}
function context(client, extras = {}) {
  return { supabase: client, Date: FixedDate, normalizeAssistantOutput, trimText, TREEHOLE_AUTONOMOUS_POLICY, WEATHER_SHADOW_POLICY, ...extras }
}
const plain = value => JSON.parse(JSON.stringify(value))

for (const [name, next] of [
  ["getAutonomousTreeholeContext", "async function generateAndSaveTreeholeUpdates"],
  ["loadWeatherShadowRecentContext", "function formatWeatherShadowRecentContext"],
  ["getRecentMomentChatContext", "function getMomentLocalTime"],
]) test(`${name} preserves output for photos, voice text and legacy metadata without Base64`, async () => {
  const tables = { messages, treehole_entries: [{ user_id: "user", tag: "海边", content: ["offline entry"], created_at: "2026-10-07T00:00:00Z" }] }
  const optimized = queryFixture(tables), original = queryFixture(tables)
  const run = (client, legacy) => vm.runInNewContext(`${body(name, next, legacy)}\n${name}`, context(client))("user")
  const [actual, expected] = await Promise.all([run(optimized, false), run(original, true)])
  assert.deepEqual(plain(actual), plain(expected))
  assert.doesNotMatch(JSON.stringify(actual), /must not leak|hidden/)
  for (const read of optimized.reads.filter(r => r.table === "messages")) assert.doesNotMatch(JSON.stringify(read.data), /base64|AAAA/)
  if (name !== "loadWeatherShadowRecentContext") assert.match(JSON.stringify(actual), /阳光下的海岸/)
  if (name === "getAutonomousTreeholeContext") {
    assert.ok(actual.sourceMessages.some(m => m.id === "photo" && m.role === "user"))
    assert.ok(actual.sourceMessages.some(m => m.id === "voice" && m.content.includes("语音")))
  }
})

test("consideration keeps material eligibility, image description, provenance, model input and rhythm", async () => {
  const run = async (legacy, due = true) => {
    const client = queryFixture({ messages, moment_autonomous_state: [{ user_id: "user", next_consider_at: due ? "2026-10-08T06:00:00Z" : "2026-10-09T00:00:00Z" }], moment_entries: [], moment_candidates: [], album_assets: [] })
    const captured = { prompts: [], stateUpdates: [] }
    const fn = vm.runInNewContext(`${body("checkAutonomousMomentConsideration", "async function checkPendingMomentCandidates", legacy)}\ncheckAutonomousMomentConsideration`, context(client, {
      APP_USER: { defaultUserId: "user" }, CONTEXT_BUDGET, MOMENT_MATERIAL_FETCH_LIMIT, MOMENT_MATERIAL_RETENTION_HOURS,
      isMomentQuietHours: () => false, assignMomentMaterialAliases, selectRetainedMomentMaterials, buildAlbumMomentMaterials, formatMomentMaterialsForPrompt,
      formatAutonomousMomentEnvironment: () => "same time", formatRecentAutonomousMomentThemes: () => "same history", buildAutonomousMomentPrompt: options => options,
      callSmallLLM: async prompt => { captured.prompts.push(prompt); return JSON.stringify({ shouldPost: false }) },
      parseMomentCandidate, getMomentCandidateAdmission,
      updateAutonomousMomentState: async (_user, _state, update) => captured.stateUpdates.push(update),
      markAutonomousMomentError: error => error,
    }))
    captured.result = plain(await fn()); return { client, captured: plain(captured) }
  }
  const actual = await run(false), expected = await run(true)
  assert.deepEqual(actual.captured, expected.captured)
  assert.match(JSON.stringify(actual.captured.prompts), /阳光下的海岸/)
  assert.equal(actual.captured.prompts.length, 1)
  assert.doesNotMatch(JSON.stringify(actual.client.reads), /base64|AAAA|must not leak/)
  const notDue = await run(false, false)
  assert.equal(notDue.captured.prompts.length, 0); assert.equal(notDue.client.reads.length, 1)
})

import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { AI_MODELS, CHAT_MODEL_OPTIONS } from "../lib/aiConfig.js"

const requireMobile = createRequire(new URL("../mobile/XiaoC/package.json", import.meta.url))
const ts = requireMobile("typescript")
function load(file) {
  const values = new Map()
  const storage = { getItem: async k => values.get(k) || null, setItem: async (k, v) => values.set(k, v) }
  const exports = {}
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText
  vm.runInNewContext(code, { exports, require: id => {
    if (id === "@react-native-async-storage/async-storage") return storage
    if (id === "../config/api") return { APP_USER_ID: "synthetic", apiJson: async () => { throw new Error("no network") } }
    throw new Error(id)
  } })
  return { exports, values }
}
test("mobile picker matches backend and migrates persisted old IDs", async () => {
  const { exports: m, values } = load("mobile/XiaoC/src/lib/modelSettings.ts")
  assert.deepEqual(Array.from(m.AVAILABLE_CHAT_MODELS, x => x.id), CHAT_MODEL_OPTIONS.map(x => x.id))
  assert.equal((await m.getSelectedChatModel()).id, AI_MODELS.chat)
  for (const [oldId, id] of [["anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4.6"], ["anthropic/claude-haiku-4.5", AI_MODELS.memoryJudge]]) {
    values.set("xiaoc:selected_chat_model", oldId)
    assert.equal((await m.getSelectedChatModel()).id, id)
    await m.saveSelectedChatModel(oldId)
    assert.equal(values.get("xiaoc:selected_chat_model"), id)
  }
  assert.equal((await m.saveSelectedChatModel("anthropic/claude-opus-5.5")).id, "anthropic/claude-opus-5.5")
})
test("new-model local fallback handles cache prices, long-input Haiku and actual cost", async () => {
  for (const [model, prompt, expected] of [
    [AI_MODELS.chat, 1000, 0.00301],
    ["anthropic/claude-opus-5.5", 1000, 0.00602],
    [AI_MODELS.memoryJudge, 1000, 0.000151],
    [AI_MODELS.memoryJudge, 100000, 0.050255],
  ]) {
    const { exports: c } = load("mobile/XiaoC/src/lib/costState.ts")
    await c.saveChatUsageFromResponse({ model, usage: { prompt_tokens: prompt, completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 100 } } })
    const records = await c.getUsageRecords()
    assert.ok(Math.abs(records[0].costUsd - expected) < 1e-10, `${model}: ${records[0].costUsd}`)
    await c.saveChatUsageFromResponse({ model, usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.123 } })
    assert.ok((await c.getUsageRecords()).some(r => r.costSource === "actual" && r.costUsd === 0.123))
  }
})

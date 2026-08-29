import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  AI_MODELS,
  CHAT_MODEL_OPTIONS,
  normalizeChatModel,
} from "../lib/aiConfig.js"

const expectedModels = [
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-opus-4.1",
]

test("main chat allowlist contains the current XiaoC-compatible Claude models", () => {
  assert.deepEqual(CHAT_MODEL_OPTIONS.map((model) => model.id), expectedModels)

  for (const model of expectedModels) {
    assert.equal(normalizeChatModel(model), model)
  }

  assert.equal(normalizeChatModel("anthropic/unknown"), AI_MODELS.chat)
})

test("mobile model options stay aligned without changing the default", () => {
  const source = readFileSync(
    "mobile/XiaoC/src/lib/modelSettings.ts",
    "utf8",
  )

  for (const model of expectedModels) {
    assert.match(source, new RegExp(model.replace(/[.]/g, "\\.")))
  }

  assert.match(
    source,
    /DEFAULT_CHAT_MODEL[\s\S]*anthropic\/claude-sonnet-4\.6/,
  )
})

test("selecting a main model does not change background model assignments", () => {
  assert.equal(AI_MODELS.chat, "anthropic/claude-sonnet-4.6")
  assert.equal(AI_MODELS.imageDescription, "anthropic/claude-haiku-4.5")
  assert.equal(AI_MODELS.memoryJudge, "anthropic/claude-haiku-4.5")
  assert.equal(AI_MODELS.summary, "anthropic/claude-haiku-4.5")
})

test("local cost fallback includes OpenRouter cache prices for new models", () => {
  const source = readFileSync("mobile/XiaoC/src/lib/costState.ts", "utf8")

  assert.match(source, /"anthropic\/claude-sonnet-5"[\s\S]*cacheRead: 0\.2[\s\S]*cacheWrite1h: 4/)
  assert.match(source, /"anthropic\/claude-opus-5"[\s\S]*cacheRead: 0\.5[\s\S]*cacheWrite1h: 10/)
  assert.match(source, /uncachedInputTokens/)
  assert.match(source, /cacheWriteTokens \* price\.cacheWrite1h/)
})

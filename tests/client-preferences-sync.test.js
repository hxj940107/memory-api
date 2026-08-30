import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("non-sensitive client preferences reuse user-state without adding an API function", () => {
  const api = readFileSync("api/user-state.js", "utf8")
  const migration = readFileSync("supabase_client_preferences.sql", "utf8")
  const client = readFileSync(
    "mobile/XiaoC/src/lib/cloudPreferences.ts",
    "utf8",
  )

  assert.match(migration, /client_preferences jsonb/)
  assert.match(api, /action === "client-preferences"/)
  assert.match(api, /action === "set-client-preferences"/)
  assert.match(api, /action === "upload-client-preference-image"/)
  assert.match(api, /PROFILE_IMAGE_BUCKET = "album-images"/)
  assert.match(client, /syncClientPreferences/)
  assert.match(client, /uploadClientPreferenceImage/)
  assert.doesNotMatch(api, /password|faceId|face_id|push_token.*CLIENT_PREFERENCE_KEYS/)
})

test("main chat usage is persisted with the assistant message and queried cross-device", () => {
  const chat = readFileSync("api/chat.js", "utf8")
  const userState = readFileSync("api/user-state.js", "utf8")
  const costState = readFileSync(
    "mobile/XiaoC/src/lib/costState.ts",
    "utf8",
  )

  assert.match(chat, /llmUsage: mainChatUsage/)
  assert.match(chat, /request_purpose: "normal_chat"/)
  assert.match(userState, /action === "chat-usage-summary"/)
  assert.match(userState, /metadata\?\.llmUsage/)
  assert.match(costState, /action: "chat-usage-summary"/)
})

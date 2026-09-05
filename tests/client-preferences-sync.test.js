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

test("Face ID and password unlock share the same personalized welcome", () => {
  const welcome = readFileSync("mobile/XiaoC/src/app/index.tsx", "utf8")
  const account = readFileSync(
    "mobile/XiaoC/src/lib/accountSettings.ts",
    "utf8",
  )

  assert.match(welcome, /syncClientPreferences\(\)/)
  assert.match(welcome, /result\.success[\s\S]*showWelcomeThenEnter\(\)/)
  assert.match(welcome, /value === savedPassword[\s\S]*showWelcomeThenEnter\(\)/)
  assert.match(welcome, /if \(!accountPassword\) \{[\s\S]*showWelcomeThenEnter\(\)/)
  assert.match(welcome, /\{displayName\}/)
  assert.match(account, /DEFAULT_ACCOUNT_NAME = "大天使长"/)
  assert.match(account, /LEGACY_DEFAULT_ACCOUNT_NAME = "小天使"/)
})

test("welcome initialization never waits for cloud preferences and always exits its pending state", () => {
  const welcome = readFileSync("mobile/XiaoC/src/app/index.tsx", "utf8")

  assert.match(
    welcome,
    /const initializeLocalAuth = async \(\) => \{[\s\S]*Promise\.allSettled\(\[[\s\S]*getAccountSettings\(\)[\s\S]*getAccountPassword\(\)/,
  )
  assert.match(welcome, /void initializeLocalAuth\(\)\.catch\([\s\S]*setUnlockReady\(true\)/)
  assert.match(welcome, /void syncClientPreferences\(\)\.catch/)
  assert.doesNotMatch(
    welcome,
    /syncClientPreferences\(\)[\s\S]{0,300}\.then\([\s\S]{0,300}getAccountSettings\(\)/,
  )
  assert.match(
    welcome,
    /passwordResult\.status === 'rejected'[\s\S]*setUnlockReady\(true\)/,
  )
  assert.match(
    welcome,
    /LocalAuthentication\.authenticateAsync\([\s\S]*\.catch\([\s\S]*setUnlockReady\(true\)/,
  )
})

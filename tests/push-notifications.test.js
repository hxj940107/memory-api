import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  buildContentUpdatePushMessage,
  buildProactivePushMessage,
  isExpoPushToken,
  sendExpoPushMessage,
} from "../lib/pushNotifications.js"

test("content update notifications use fixed quiet copy", () => {
  const moments = buildContentUpdatePushMessage({
    token: "ExponentPushToken[abc123]",
    type: "moments_update",
  })
  const treehole = buildContentUpdatePushMessage({
    token: "ExponentPushToken[abc123]",
    type: "treehole_update",
  })

  assert.equal(moments.title, "小C")
  assert.equal(moments.body, "小C刚刚更新了朋友圈")
  assert.equal(moments.sound, null)
  assert.equal(moments.data.type, "moments_update")
  assert.equal(treehole.body, "小C刚刚更新了树洞")
  assert.equal(treehole.sound, null)
})

test("push token validation is strict", () => {
  assert.equal(isExpoPushToken("ExponentPushToken[abc123]"), true)
  assert.equal(isExpoPushToken("ExpoPushToken[abc123]"), true)
  assert.equal(isExpoPushToken("abc123"), false)
})

test("private notification mode does not expose message content", () => {
  const message = buildProactivePushMessage({
    token: "ExponentPushToken[abc123]",
    content: "宝宝，我有点想你了",
    previewEnabled: false,
    data: { conversationId: "chat-1", messageId: "message-1" },
  })
  assert.equal(message.body, "发来了一条消息")
  assert.equal(message.data.conversationId, "chat-1")
})

test("successful Expo ticket is attributed without claiming APNs delivery", async () => {
  const result = await sendExpoPushMessage(
    { to: "ExponentPushToken[abc123]", body: "hi" },
    {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { status: "ok", id: "ticket-1" } }),
      }),
    },
  )
  assert.equal(result.attempted, true)
  assert.equal(result.delivered_to_expo, true)
  assert.equal(result.ticket_id, "ticket-1")
})

test("proactive messages persist before attempting push and duplicate messages do not re-push", () => {
  const source = fs.readFileSync("api/memory.js", "utf8")
  const insert = source.indexOf('.from("messages")\n    .insert({', source.indexOf("async function saveProactiveMessage"))
  const push = source.indexOf("sendExpoPushMessage(", source.indexOf("async function saveProactiveMessage"))
  const duplicateReturn = source.indexOf("return String(existingMessage.id)", source.indexOf("async function saveProactiveMessage"))
  assert.ok(insert >= 0 && push > insert)
  assert.ok(duplicateReturn >= 0 && duplicateReturn < insert)
  assert.match(source, /pushNotification:/)
})

test("mobile app registers notification taps and preserves delayed Face ID relock", () => {
  const layout = fs.readFileSync("mobile/XiaoC/src/app/_layout.tsx", "utf8")
  const settings = fs.readFileSync("mobile/XiaoC/src/app/settings.tsx", "utf8")
  const account = fs.readFileSync("mobile/XiaoC/src/lib/accountSettings.ts", "utf8")
  assert.match(layout, /addNotificationResponseReceivedListener/)
  assert.match(layout, /addNotificationReceivedListener/)
  assert.match(layout, /currentPath === "\/chat"/)
  assert.match(layout, /inAppBanner/)
  assert.match(layout, /BACKGROUND_AUTO_LOCK_DELAY_MS = 60 \* 60 \* 1000/)
  assert.match(layout, /elapsed >= BACKGROUND_AUTO_LOCK_DELAY_MS/)
  assert.doesNotMatch(layout, /privacyCover/)
  assert.match(settings, /label="应用锁"/)
  assert.match(settings, /text: "不使用应用锁"/)
  assert.doesNotMatch(settings, /label="密码"/)
  assert.doesNotMatch(settings, /label="Face ID"/)
  assert.match(account, /Boolean\(password\) && faceIdEnabled === "1"/)
  assert.match(account, /clearAccountPassword[\s\S]*removeItem\(ACCOUNT_FACE_ID_KEY\)/)
  assert.match(settings, /LocalAuthentication\.authenticateAsync/)
  assert.match(account, /SecureStore\.setItemAsync/)
  assert.match(account, /ACCOUNT_PASSWORD_SECURE_KEY = "xiaoc\.account_password"/)
  assert.match(account, /LEGACY_ACCOUNT_PASSWORD_KEY = "xiaoc:account_password"/)
  assert.doesNotMatch(account, /SecureStore\.(?:getItemAsync|setItemAsync|deleteItemAsync)\([^)]*LEGACY_ACCOUNT_PASSWORD_KEY/)
  assert.doesNotMatch(account, /AsyncStorage\.setItem\([^)]*normalizedPassword/)

  const api = fs.readFileSync("mobile/XiaoC/src/config/api.ts", "utf8")
  assert.match(api, /PRIVATE_APP_TOKEN_KEY = "xiaoc\.private_api_token"/)
})

test("foreground XiaoC messages use a custom banner outside chat without duplicating the native banner", () => {
  const layout = fs.readFileSync("mobile/XiaoC/src/app/_layout.tsx", "utf8")
  const notifications = fs.readFileSync("mobile/XiaoC/src/lib/pushNotifications.ts", "utf8")

  assert.match(notifications, /shouldShowBanner: false/)
  assert.match(notifications, /data\?\.type !== "xiaoc_message"/)
  assert.match(layout, /currentPath === "\/chat" \|\| currentPath === "\/"/)
  assert.match(layout, /router\.push\(\{ pathname: "\/chat"/)
  assert.match(layout, /numberOfLines=\{2\}/)
})

test("normal chat replies also dispatch push while the client suppresses it on the chat screen", () => {
  const chat = fs.readFileSync("api/chat.js", "utf8")
  const layout = fs.readFileSync("mobile/XiaoC/src/app/_layout.tsx", "utf8")

  const saveIndex = chat.indexOf("const assistantMessageId = await saveMessage(")
  const pushIndex = chat.indexOf("waitUntil(sendNormalChatPush({", saveIndex)
  assert.ok(saveIndex >= 0 && pushIndex > saveIndex)
  assert.match(chat, /messageType: "normal_chat"/)
  assert.match(chat, /push_notifications_enabled/)
  assert.match(layout, /currentPath === "\/chat"/)
})

test("Moments and treehole updates notify only after visible content exists", () => {
  const memory = fs.readFileSync("api/memory.js", "utf8")
  const layout = fs.readFileSync("mobile/XiaoC/src/app/_layout.tsx", "utf8")
  const settings = fs.readFileSync("mobile/XiaoC/src/app/settings.tsx", "utf8")

  const treeholeInsert = memory.indexOf('.from("treehole_entries")\n    .insert(', memory.indexOf("async function generateAndSaveTreeholeUpdates"))
  const treeholePush = memory.indexOf('sendContentUpdateNotification(user_id, "treehole_update")', treeholeInsert)
  const momentInsert = memory.indexOf('.from("moment_entries")\n        .insert({', memory.indexOf("async function publishPendingMomentCandidates"))
  const momentPush = memory.indexOf('sendContentUpdateNotification(candidate.user_id, "moments_update")', momentInsert)

  assert.ok(treeholeInsert >= 0 && treeholePush > treeholeInsert)
  assert.ok(momentInsert >= 0 && momentPush > momentInsert)
  assert.match(memory, /push_moments_enabled/)
  assert.match(memory, /push_treehole_enabled/)
  assert.match(layout, /currentPath\.startsWith\("\/moments"\)/)
  assert.match(layout, /currentPath\.startsWith\("\/treehole"\)/)
  assert.match(layout, /router\.push\("\/moments"\)/)
  assert.match(layout, /router\.push\("\/treehole"\)/)
  assert.match(settings, /label="朋友圈更新通知"/)
  assert.match(settings, /label="树洞更新通知"/)
})

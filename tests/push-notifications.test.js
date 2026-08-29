import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  buildProactivePushMessage,
  isExpoPushToken,
  sendExpoPushMessage,
} from "../lib/pushNotifications.js"

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

test("mobile app registers notification taps and Face ID privacy protection", () => {
  const layout = fs.readFileSync("mobile/XiaoC/src/app/_layout.tsx", "utf8")
  const settings = fs.readFileSync("mobile/XiaoC/src/app/settings.tsx", "utf8")
  const account = fs.readFileSync("mobile/XiaoC/src/lib/accountSettings.ts", "utf8")
  assert.match(layout, /addNotificationResponseReceivedListener/)
  assert.match(layout, /privacyCovered/)
  assert.match(settings, /LocalAuthentication\.authenticateAsync/)
  assert.match(account, /SecureStore\.setItemAsync/)
  assert.doesNotMatch(account, /AsyncStorage\.setItem\(ACCOUNT_PASSWORD_KEY, normalizedPassword\)/)
})

import assert from "node:assert/strict"
import fs from "node:fs"
import {
  hasRealWorldMeetingEvidence,
  isConversationalMeetingGoodbye,
} from "../lib/planFollowUpGuard.js"

for (const message of [
  "哼 这还差不多 下午见",
  "晚上见",
  "回头见",
  "待会见",
  "一会儿见",
  "明天见",
]) {
  assert.equal(isConversationalMeetingGoodbye(message, { items: [] }), true, message)
}

for (const message of [
  "下午去医院看医生",
  "晚上和朋友吃饭",
  "等会去做护理",
  "明天见客户",
  "下午在咖啡店见",
  "明天下午三点见",
]) {
  assert.equal(isConversationalMeetingGoodbye(message, { items: [] }), false, message)
}

assert.equal(
  isConversationalMeetingGoodbye("下午见", {
    items: [{ topic: "见朋友", context: "约好下午和朋友见面" }],
  }),
  false
)
assert.equal(hasRealWorldMeetingEvidence("明天见客户", { items: [] }), true)

const chat = fs.readFileSync("api/chat.js", "utf8")
assert.match(chat, /const conversationalGoodbye = isConversationalMeetingGoodbye/)
assert.match(chat, /planDecision: conversationalGoodbye\s*\? null/)
assert.match(
  chat,
  /activeContext: conversationalGoodbye\s*\? resolveActiveConversationContext\(previousActiveContext, null\)/
)
assert.match(chat, /if \(planTask\)[\s\S]*?else \{[\s\S]*?enqueueInactivityReachOutTask/)

console.log("plan follow-up goodbye tests passed")

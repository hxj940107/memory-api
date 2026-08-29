import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

test("autonomous treehole checks for new shared-life material before calling the model", () => {
  const config = fs.readFileSync("lib/aiConfig.js", "utf8")
  const source = fs.readFileSync("api/memory.js", "utf8")

  assert.match(config, /minimumNewUserMessages: 2/)
  assert.match(config, /minimumNewChatChars: 160/)
  assert.match(source, /treehole_generation_attempted: false/)
  assert.match(source, /insufficient_new_material/)
  assert.match(source, /newUserChars >= TREEHOLE_AUTONOMOUS_POLICY\.minimumNewChatChars/)
  assert.match(source, /treehole_new_user_chars/)
  assert.match(source, /generateAndSaveTreeholeUpdates\(task\.user_id, "autonomous", context\)/)
})

test("a paid autonomous treehole generation must produce visible entries", () => {
  const source = fs.readFileSync("api/memory.js", "utf8")

  assert.match(source, /是她长期相处的恋人和伴侣，不是生活助手、朋友或旁观记录者/)
  assert.match(source, /至少返回 1 条 draft；不要返回空 drafts/)
  assert.match(source, /treehole_generation_returned_no_visible_draft/)
  assert.match(source, /treehole_generation_result: "visible_entries_written"/)
  assert.match(source, /treehole_generation_retry_suppressed: true/)
})

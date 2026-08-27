import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import { getSavedMessageId } from "../lib/messagePersistence.js"

test("saved assistant response resolves to the database UUID, not the row", () => {
  const row = {
    id: "79dd12a3-cc85-4f68-b7e7-fbc300f22618",
    role: "assistant",
    content: "hello",
  }
  const result = getSavedMessageId({ data: [row] })

  assert.equal(result, row.id)
  assert.equal(typeof result, "string")
  assert.notEqual(result, row)
})

test("invalid add-message payloads do not become assistant IDs", () => {
  assert.equal(getSavedMessageId({ data: [{ id: { value: "bad" } }] }), null)
  assert.equal(getSavedMessageId({ data: [{}] }), null)
})

test("api chat returns the validated saveMessage string as assistant_message_id", () => {
  const source = fs.readFileSync("api/chat.js", "utf8")
  const saveStart = source.indexOf("async function saveMessage")
  const continuityStart = source.indexOf("async function getLatestConversationContinuity")
  const saveSource = source.slice(saveStart, continuityStart)

  assert.match(saveSource, /const messageId = getSavedMessageId\(data\)/)
  assert.match(saveSource, /return messageId/)
  assert.doesNotMatch(saveSource, /return data\?\.data\?\.\[0\]/)
  assert.match(source, /assistant_message_id: assistantMessageId/)
})

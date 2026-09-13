import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import {
  getSavedMessageId,
  requireSavedMessageId,
} from "../lib/messagePersistence.js"

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

test("failed or malformed user persistence stops before model execution", () => {
  assert.throws(
    () => requireSavedMessageId({
      ok: false,
      status: 500,
      payload: {
        error: "Message could not be saved",
        code: "message_persistence_failed",
      },
      role: "user",
    }),
    (error) =>
      error.code === "message_persistence_failed" && error.status === 500,
  )
  assert.throws(
    () => requireSavedMessageId({
      ok: true,
      status: 200,
      payload: { data: [] },
      role: "user",
    }),
    /missing a string id/,
  )
  assert.equal(
    requireSavedMessageId({
      ok: true,
      status: 200,
      payload: { data: [{ id: "user-message-id" }] },
      role: "user",
    }),
    "user-message-id",
  )
})

test("api chat returns the validated saveMessage string as assistant_message_id", () => {
  const source = fs.readFileSync("api/chat.js", "utf8")
  const saveStart = source.indexOf("async function saveMessage")
  const continuityStart = source.indexOf("async function getLatestConversationContinuity")
  const saveSource = source.slice(saveStart, continuityStart)

  assert.match(saveSource, /return requireSavedMessageId\(\{/)
  assert.doesNotMatch(saveSource, /return data\?\.data\?\.\[0\]/)
  assert.match(source, /assistant_message_id: assistantMessageId/)
})

test("chat requires a persisted user message id before loading history or calling the model", () => {
  const source = fs.readFileSync("api/chat.js", "utf8")
  const saveUserStart = source.indexOf("async function saveUserMessage")
  const findExistingStart = source.indexOf("async function findExistingClientTurn")
  const saveUserSource = source.slice(saveUserStart, findExistingStart)
  const userSave = source.indexOf("const userMessageId = await saveUserMessage(")
  const historyLoad = source.indexOf("const historyCandidates = await getRecentMessages(")
  const modelCall = source.indexOf("let llm = await callLLM(messages, selectedChatModel")

  assert.match(saveUserSource, /return requireSavedMessageId\(\{/)
  assert.match(saveUserSource, /role: "user"/)
  assert.ok(userSave >= 0)
  assert.ok(historyLoad > userSave)
  assert.ok(modelCall > userSave)
  assert.doesNotMatch(saveUserSource, /return data\?\.data\?\.\[0\]\?\.id \|\| null/)
  assert.match(source, /e\?\.code === "message_persistence_failed"/)
})

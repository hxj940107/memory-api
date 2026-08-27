import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  getStableMessageId,
  getValidCloudMessageId,
  mergeCloudMessages,
  reconcileLocalMessageCloudId,
  upsertCloudMessage,
} from "../mobile/XiaoC/src/lib/messageSync.ts"

const cloudMessage = (id, overrides = {}) => ({
  id,
  cloudId: id,
  role: "assistant",
  text: `message-${id}`,
  createdAt: "2026-08-20T08:00:00.000Z",
  status: "sent",
  ...overrides,
})

test("polling first and HTTP second keeps one assistant message", () => {
  const fromPolling = cloudMessage("assistant-1")
  let state = mergeCloudMessages([], [fromPolling])

  state = upsertCloudMessage(state, cloudMessage("assistant-1", {
    text: "HTTP reply",
    createdAt: "2026-08-20T08:00:01.000Z",
  }))

  assert.equal(state.length, 1)
  assert.equal(state[0].cloudId, "assistant-1")
  assert.equal(state[0].text, "HTTP reply")
  assert.equal(state[0].createdAt, fromPolling.createdAt)
})

test("HTTP first and polling second keeps one assistant message", () => {
  let state = upsertCloudMessage([], cloudMessage("assistant-1", {
    text: "HTTP reply",
  }))

  state = mergeCloudMessages(state, [cloudMessage("assistant-1", {
    text: "HTTP reply",
  })])

  assert.equal(state.length, 1)
  assert.equal(getStableMessageId(state[0]), "assistant-1")
})

test("an object assistant id is rejected instead of becoming object Object", () => {
  const invalidId = getValidCloudMessageId({ id: "assistant-1" })
  assert.equal(invalidId, null)
  assert.notEqual(invalidId, "[object Object]")

  const source = readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")
  assert.doesNotMatch(source, /String\(data\.assistant_message_id\)/)
  assert.match(source, /getValidCloudMessageId\(data\.assistant_message_id\)/)
  assert.match(source, /data\.assistant_message_id != null && !assistantCloudId[\s\S]*return;/)
})

test("identical assistant text with different server ids remains two messages", () => {
  let state = upsertCloudMessage([], cloudMessage("assistant-1", { text: "same" }))
  state = upsertCloudMessage(state, cloudMessage("assistant-2", {
    text: "same",
    createdAt: "2026-08-20T08:00:01.000Z",
  }))

  assert.equal(state.length, 2)
  assert.deepEqual(state.map(getStableMessageId), ["assistant-1", "assistant-2"])
})

test("generated attachment response and history reconcile by the same server id", () => {
  const attachment = {
    id: "attachment-1",
    name: "notes.md",
    type: "markdown",
  }
  let state = upsertCloudMessage([], cloudMessage("assistant-file", {
    text: "整理好了",
    attachments: [attachment],
  }))
  state = mergeCloudMessages(state, [cloudMessage("assistant-file", {
    text: "整理好了",
    attachments: [attachment],
  })])

  assert.equal(state.length, 1)
  assert.deepEqual(state[0].attachments, [attachment])
})

test("repeated proactive polling is idempotent and preserves render identity", () => {
  const proactive = cloudMessage("proactive-1", {
    metadata: { proactive: true, proactiveTaskId: "task-9" },
  })
  const first = mergeCloudMessages([], [proactive])
  const second = mergeCloudMessages(first, [{ ...proactive }])

  assert.equal(second.length, 1)
  assert.equal(second, first)
  assert.equal(second[0], first[0])
})

test("focus refresh with the same cloud batch does not replace state", () => {
  const initial = [cloudMessage("a"), cloudMessage("b", {
    createdAt: "2026-08-20T08:01:00.000Z",
  })]
  const refreshed = mergeCloudMessages(initial, initial.map((message) => ({ ...message })))

  assert.equal(refreshed, initial)
})

test("local user message reconciles with a copy already seen by polling", () => {
  const local = {
    id: "local-1",
    clientId: "local-1",
    role: "user",
    text: "hello",
    createdAt: "2026-08-20T08:00:00.000Z",
    status: "sending",
  }
  const server = {
    ...local,
    id: "user-1",
    cloudId: "user-1",
    clientId: "local-1",
    status: "sent",
  }
  const afterPolling = mergeCloudMessages([local], [server])

  assert.equal(afterPolling.length, 1)
  assert.equal(afterPolling[0].id, "user-1")
  assert.equal(afterPolling[0].cloudId, "user-1")

  const reconciled = reconcileLocalMessageCloudId(
    afterPolling,
    "local-1",
    "user-1",
    { status: "sent" },
  )

  assert.equal(reconciled.length, 1)
  assert.equal(reconciled[0].id, "user-1")
  assert.equal(reconciled[0].cloudId, "user-1")
})

test("identical user text with different client ids remains two messages", () => {
  const first = {
    id: "local-1",
    clientId: "local-1",
    role: "user",
    text: "same text",
    createdAt: "2026-08-20T08:00:00.000Z",
    status: "sending",
  }
  const second = {
    ...first,
    id: "local-2",
    clientId: "local-2",
    createdAt: "2026-08-20T08:00:01.000Z",
  }
  const cloudFirst = {
    ...first,
    id: "user-1",
    cloudId: "user-1",
    status: "sent",
  }

  const state = mergeCloudMessages([first, second], [cloudFirst])

  assert.equal(state.length, 2)
  assert.deepEqual(state.map((message) => message.clientId), ["local-1", "local-2"])
})

test("equal timestamps use stable message id as the secondary order", () => {
  const state = mergeCloudMessages([], [cloudMessage("b"), cloudMessage("a")])
  assert.deepEqual(state.map(getStableMessageId), ["a", "b"])
})

test("chat rendering uses stable ids for messages and split bubbles", () => {
  const source = readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")
  assert.match(source, /<Fragment key=\{stableMessageId\}>/)
  assert.match(source, /key=\{`\$\{stableMessageId\}_segment_\$\{segmentIndex\}`\}/)
  assert.match(source, /setInterval\(refreshIfCloudHistoryChanged, 30_000\)/)
  assert.match(source, /silent\s*\? mergeCloudMessages\(current, restoredMessages\)/)
  assert.doesNotMatch(source, /id: createLocalMessageId\(\),\s*\n\s*cloudId: item\.id/)
  assert.match(source, /client_message_id: messageToSend\.clientId \|\| messageToSend\.id/)
})

test("chat persists the client message identity before calling the model", () => {
  const source = readFileSync("api/chat.js", "utf8")
  const metadataWrite = source.indexOf("metadata.clientMessageId = clientMessageId")
  const userSave = source.indexOf("const userMessageId = await saveUserMessage(")
  const modelCall = source.indexOf("let llm = await callLLM(messages, selectedChatModel")

  assert.ok(metadataWrite >= 0)
  assert.ok(userSave >= 0)
  assert.ok(modelCall >= 0)
  assert.ok(userSave < modelCall)
})

test("history API adds message id as a stable secondary order", () => {
  const source = readFileSync("api/history.js", "utf8")
  assert.match(
    source,
    /\.order\("created_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: false \}\)/,
  )
})

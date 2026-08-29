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

const cloudPage = (start, count) =>
  Array.from({ length: count }, (_, index) => {
    const sequence = start + index
    return cloudMessage(`message-${String(sequence).padStart(3, "0")}`, {
      createdAt: new Date(Date.UTC(2026, 7, 20, 8, 0, sequence)).toISOString(),
    })
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

test("history pages accumulate from 60 to 120 to 180 messages", () => {
  const latest = cloudPage(120, 60)
  const middle = cloudPage(60, 60)
  const oldest = cloudPage(0, 60)

  const firstPage = mergeCloudMessages([], latest)
  const secondPage = mergeCloudMessages(firstPage, middle)
  const thirdPage = mergeCloudMessages(secondPage, oldest)

  assert.equal(firstPage.length, 60)
  assert.equal(secondPage.length, 120)
  assert.equal(thirdPage.length, 180)
  assert.deepEqual(
    thirdPage.map(getStableMessageId),
    cloudPage(0, 180).map(getStableMessageId),
  )
})

test("overlapping history page ids are deduplicated", () => {
  const current = cloudPage(60, 60)
  const overlappingOlderPage = cloudPage(30, 60)
  const merged = mergeCloudMessages(current, overlappingOlderPage)

  assert.equal(merged.length, 90)
  assert.equal(new Set(merged.map(getStableMessageId)).size, 90)
  assert.deepEqual(
    merged.map(getStableMessageId),
    cloudPage(30, 90).map(getStableMessageId),
  )
})

test("a new message remains after older history is merged", () => {
  const latest = cloudPage(60, 60)
  const withNewMessage = upsertCloudMessage(
    latest,
    cloudMessage("message-120", {
      createdAt: new Date(Date.UTC(2026, 7, 20, 8, 2, 0)).toISOString(),
    }),
  )
  const merged = mergeCloudMessages(withNewMessage, cloudPage(0, 60))

  assert.equal(merged.length, 121)
  assert.equal(getStableMessageId(merged.at(-1)), "message-120")
})

test("an empty older page preserves the accumulated history", () => {
  const current = cloudPage(0, 120)
  const merged = mergeCloudMessages(current, [])

  assert.equal(merged, current)
  assert.equal(merged.length, 120)
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
  assert.match(source, /const clientMessageId = messageToSend\.clientId \|\| messageToSend\.id/)
  assert.match(source, /client_message_id: clientMessageId/)
  assert.match(source, /回复可能仍在处理中，不用重复发送/)
  assert.match(source, /replyToClientMessageId === pendingReplyClientId/)
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
  assert.match(source, /findExistingClientTurn\(/)
  assert.match(source, /CHAT CLIENT MESSAGE DEDUPLICATED/)
  assert.match(source, /CHAT CLIENT MESSAGE STILL PROCESSING/)
  assert.match(source, /replyToUserMessageId: userMessageId/)
  assert.match(source, /replyToClientMessageId: normalizedClientMessageId/)
})

test("history API adds message id as a stable secondary order", () => {
  const source = readFileSync("api/history.js", "utf8")
  assert.match(
    source,
    /\.order\("created_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: false \}\)/,
  )
})

test("chat history loads older messages with a stable cursor and manual pull", () => {
  const apiSource = readFileSync("api/history.js", "utf8")
  const chatSource = readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")

  assert.match(apiSource, /before_created_at/)
  assert.match(
    apiSource,
    /created_at\.lt\.\$\{cursorTime\},and\(created_at\.eq\.\$\{cursorTime\},id\.lt\.\$\{before_id\}\)/,
  )
  assert.match(chatSource, /const HISTORY_PAGE_SIZE = 60/)
  assert.match(chatSource, /<RefreshControl[\s\S]*onRefresh=\{loadOlderHistory\}/)
  assert.match(chatSource, /before_created_at: oldestCloudMessage\.createdAt/)
  assert.match(chatSource, /before_id: String\(oldestCloudMessage\.cloudId\)/)
  assert.match(chatSource, /prependAnchorRef\.current = \{/)
  assert.match(chatSource, /height - anchor\.contentHeight/)
  assert.match(chatSource, /conversationIdRef\.current !== id/)
  assert.match(
    chatSource,
    /silent\s*\? mergeCloudMessages\(current, restoredMessages\)\s*:\s*restoredMessages/,
  )
})

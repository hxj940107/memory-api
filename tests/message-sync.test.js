import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  getStableMessageId,
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
    role: "user",
    text: "hello",
    createdAt: "2026-08-20T08:00:00.000Z",
    status: "sending",
  }
  const server = {
    ...local,
    id: "user-1",
    cloudId: "user-1",
    status: "sent",
  }
  const afterPolling = mergeCloudMessages([local], [server])
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
})

test("history API adds message id as a stable secondary order", () => {
  const source = readFileSync("api/history.js", "utf8")
  assert.match(
    source,
    /\.order\("created_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: false \}\)/,
  )
})

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const historySource = readFileSync("api/history.js", "utf8")
const chatSource = readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")
const searchSource = readFileSync("mobile/XiaoC/src/app/chat-search.tsx", "utf8")

test("chat search queries the complete server-side conversation history", () => {
  assert.match(historySource, /action === "search"/)
  assert.match(historySource, /\.eq\("conversation_id", conversation_id\)/)
  assert.match(historySource, /\.ilike\("content", `%\$\{escapeIlikePattern\(text\)\}%`\)/)
  assert.match(historySource, /\.in\("role", \["user", "assistant"\]\)/)
  assert.doesNotMatch(searchSource, /messages\.filter/)
})

test("search results use stable created-at and message-id pagination", () => {
  assert.match(historySource, /before_created_at/)
  assert.match(historySource, /id\.lt\.\$\{before_id\}/)
  assert.match(historySource, /order\("created_at", \{ ascending: false \}\)/)
  assert.match(historySource, /order\("id", \{ ascending: false \}\)/)
  assert.match(searchSource, /before_created_at: last\.created_at/)
  assert.match(searchSource, /before_id: last\.id/)
})

test("a result opens real messages on both sides of the target", () => {
  assert.match(historySource, /action === "context"/)
  assert.match(historySource, /created_at\.lt/)
  assert.match(historySource, /created_at\.gt/)
  assert.match(searchSource, /action: "context"/)
  assert.match(searchSource, /contextSelectedBubble/)
  assert.match(searchSource, /contextScrollRef\.current\?\.scrollTo\(\{ y: targetY/)
})

test("the chat header exposes the iOS-style search entry without changing page size", () => {
  assert.match(chatSource, /accessibilityLabel="更多聊天功能"/)
  assert.match(chatSource, /搜索聊天记录/)
  assert.match(chatSource, /pathname: "\/chat-search"/)
  assert.match(chatSource, /const HISTORY_PAGE_SIZE = 60/)
  assert.doesNotMatch(searchSource, /mergeCloudMessages|loadOlderHistory/)
})

test("search is debounced and stale requests are isolated", () => {
  assert.match(searchSource, /requestVersionRef/)
  assert.match(searchSource, /setTimeout\(async \(\) =>/)
  assert.match(searchSource, /}, 300\)/)
  assert.match(searchSource, /controller\.abort\(\)/)
})

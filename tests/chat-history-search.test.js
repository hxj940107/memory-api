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
  assert.match(searchSource, /pathname: "\/chat"/)
  assert.match(searchSource, /targetMessageId: result\.id/)
  assert.match(searchSource, /searchQuery: normalizedQuery/)
  assert.match(chatSource, /action: "context", target_id: locatingMessageId/)
  assert.match(chatSource, /stableMessageId === locatedMessageId/)
  assert.match(chatSource, /scrollRef\.current\?\.scrollTo\(\{ y: targetY/)
  assert.match(chatSource, /historyLocationModeRef/)
  assert.match(chatSource, /new Map\(/)
  assert.match(chatSource, /isSearchTarget && targetSearchQuery/)
  assert.doesNotMatch(chatSource, /styles\.locatedMessage/)
  assert.match(chatSource, /setHighlightedMessageId\(messageId\)/)
  assert.match(chatSource, /}, 1450\)/)
  assert.match(chatSource, /duration: 350/)
  assert.match(chatSource, /locationHighlightGenerationRef/)
  assert.match(chatSource, /canDismissLocationHighlightRef\.current/)
  assert.doesNotMatch(chatSource, /backgroundColor: "rgba\(20, 90, 180, 0\.38\)"/)
  assert.match(chatSource, /回到最新消息/)
  assert.match(chatSource, /if \(!id \|\| historyLocationModeRef\.current/)
})

test("the chat header exposes the iOS-style search entry without changing page size", () => {
  const menuSection = chatSource.slice(
    chatSource.indexOf("const openConversationMenu"),
    chatSource.indexOf("const restoreConversation"),
  )
  assert.match(chatSource, /accessibilityLabel="更多聊天功能"/)
  assert.match(menuSection, /pathname: "\/chat-search"/)
  assert.doesNotMatch(menuSection, /showActionSheetWithOptions/)
  assert.match(chatSource, /const HISTORY_PAGE_SIZE = 60/)
  assert.doesNotMatch(searchSource, /mergeCloudMessages|loadOlderHistory/)
})

test("search result identity follows account nickname and avatar settings", () => {
  assert.match(searchSource, /getAccountSettings\(\)/)
  assert.match(searchSource, /account\.displayName/)
  assert.match(searchSource, /account\.userMomentAvatar/)
  assert.match(searchSource, /account\.xiaocMomentAvatar/)
  assert.match(searchSource, /<MomentAvatar/)
  assert.doesNotMatch(searchSource, /item\.role === "user" \? "我" : "小C"/)
})

test("search term highlight reuses the user chat bubble color", () => {
  assert.match(searchSource, /matchText:[\s\S]*color: XiaoCColors\.userBubble/)
  assert.doesNotMatch(searchSource, /#D98200/)
})

test("search is debounced and stale requests are isolated", () => {
  assert.match(searchSource, /requestVersionRef/)
  assert.match(searchSource, /setTimeout\(async \(\) =>/)
  assert.match(searchSource, /}, 300\)/)
  assert.match(searchSource, /controller\.abort\(\)/)
})

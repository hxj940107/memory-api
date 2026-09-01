import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { getPrependAnchoredOffset } from "../mobile/XiaoC/src/lib/chatScrollAnchor.ts"
import { getStableMessageId, mergeCloudMessages } from "../mobile/XiaoC/src/lib/messageSync.ts"

const page = (start, count) => Array.from({ length: count }, (_, index) => {
  const sequence = start + index
  const id = `message-${String(sequence).padStart(3, "0")}`
  return {
    id,
    cloudId: id,
    role: sequence % 2 ? "assistant" : "user",
    text: sequence % 3 ? `short-${sequence}` : `a much taller message ${sequence}`.repeat(8),
    createdAt: new Date(Date.UTC(2026, 7, 20, 8, 0, sequence)).toISOString(),
    status: "sent",
  }
})

test("60 older messages prepend into a complete 120-message history", () => {
  const latest = page(60, 60)
  const older = page(0, 60)
  const merged = mergeCloudMessages(latest, older)

  assert.equal(merged.length, 120)
  assert.deepEqual(merged.map(getStableMessageId), page(0, 120).map(getStableMessageId))
})

test("prepend compensation preserves the old visible content with variable message heights", () => {
  const anchor = { contentHeight: 4800, scrollOffsetY: 120 }
  const nextContentHeight = 9307

  assert.equal(getPrependAnchoredOffset(anchor, nextContentHeight), 4627)
  assert.equal(
    getPrependAnchoredOffset(anchor, nextContentHeight) - (nextContentHeight - anchor.contentHeight),
    anchor.scrollOffsetY,
  )
})

test("chat separates prepend anchoring from initial and new-message auto-scroll", () => {
  const source = readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")
  const autoScrollEffect = source.slice(
    source.indexOf("useEffect(() => {", source.indexOf("const scrollToLatestMessage")),
    source.indexOf("const restoreHistoryItems"),
  )
  const contentSizeHandler = source.slice(
    source.indexOf("onContentSizeChange="),
    source.indexOf("messages.map((item, index)"),
  )

  assert.match(autoScrollEffect, /skipNextMessageAutoScrollRef\.current/)
  assert.match(autoScrollEffect, /scrollToLatestMessage\(true\)/)
  assert.match(contentSizeHandler, /getPrependAnchoredOffset\(anchor, height\)/)
  assert.doesNotMatch(contentSizeHandler, /scrollToEnd/)
})

test("conversation switches invalidate stale prepend anchors and stale page results stay guarded", () => {
  const source = readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")

  assert.match(source, /conversationIdRef\.current !== id[\s\S]*prependAnchorRef\.current = null/)
  assert.ok((source.match(/if \(conversationIdRef\.current !== id\) return;/g) || []).length >= 2)
})

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  parseInlineMarkdown,
  parseMarkdownBlocks,
} from "../mobile/XiaoC/src/lib/messageMarkdown.ts"

test("bold Chinese text is parsed without exposing Markdown markers", () => {
  const tokens = parseInlineMarkdown("**《算力与心动》**")

  assert.deepEqual(tokens, [
    { type: "strong", text: "《算力与心动》" },
  ])
  assert.equal(tokens.some((token) => token.text.includes("**")), false)
})

test("plain text remains unchanged", () => {
  const text = "今晚慢慢说，不着急。"

  assert.deepEqual(parseInlineMarkdown(text), [{ type: "text", text }])
})

test("mixed Chinese Markdown keeps its block and inline meaning", () => {
  const source = [
    "# 小标题",
    "",
    "这是**粗体**、*斜体*和`代码`。",
    "",
    "- 第一项",
    "- 第二项",
    "",
    "> 一句引用",
    "",
    "---",
  ].join("\n")
  const blocks = parseMarkdownBlocks(source)

  assert.deepEqual(blocks.map((block) => block.type), [
    "heading",
    "paragraph",
    "unorderedList",
    "quote",
    "divider",
  ])
  const paragraph = blocks.find((block) => block.type === "paragraph")
  assert.ok(paragraph && paragraph.type === "paragraph")
  assert.deepEqual(
    parseInlineMarkdown(paragraph.text).map((token) => token.type),
    ["text", "strong", "text", "emphasis", "text", "code", "text"],
  )
})

test("long Markdown content is not truncated or mutated", () => {
  const source = `**开头**\n\n${"很长的收藏正文。".repeat(500)}`
  const original = source.slice()
  const blocks = parseMarkdownBlocks(source)

  assert.equal(source, original)
  assert.equal(blocks.map((block) => block.type).join(","), "paragraph,paragraph")
  assert.equal(blocks[1].type === "paragraph" && blocks[1].text.length, 4000)
})

test("favorites only applies Markdown rendering to assistant messages", () => {
  const source = readFileSync("mobile/XiaoC/src/app/favorites.tsx", "utf8")

  assert.match(source, /selectedFavorite\?\.role === "assistant"/)
  assert.match(source, /<MessageMarkdown text=\{selectedFavorite\.text\} variant="detail" \/>/)
  assert.match(source, /<Text style=\{styles\.detailText\}>\{selectedFavorite\?\.text \|\| ""\}<\/Text>/)
})

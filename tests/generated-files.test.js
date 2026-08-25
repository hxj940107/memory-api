import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  createGeneratedAttachment,
  generateFile,
  normalizeGeneratedAttachments,
  parseGeneratedFileRequest,
  signGeneratedAttachmentDownload,
} from "../lib/generatedFiles.js"
import {
  normalizeGeneratedAttachments as normalizeAppAttachments,
} from "../mobile/XiaoC/src/lib/generatedAttachments.ts"

test("generates markdown and text files as UTF-8 buffers", () => {
  const markdown = generateFile({
    type: "markdown",
    content: "# 标题\n\n正文",
    filename: "记录.md",
  })
  const text = generateFile({
    type: "text",
    content: "第一行\n第二行",
    filename: "记录.txt",
  })

  assert.equal(markdown.mime_type, "text/markdown")
  assert.equal(markdown.name, "记录.md")
  assert.equal(markdown.buffer.toString("utf8"), "# 标题\n\n正文")
  assert.equal(markdown.size, markdown.buffer.byteLength)
  assert.equal(text.mime_type, "text/plain")
  assert.equal(text.name, "记录.txt")
  assert.equal(text.buffer.toString("utf8"), "第一行\n第二行")
})

test("recognizes only explicit generated file requests", () => {
  assert.deepEqual(parseGeneratedFileRequest("生成一个 md 文件"), {
    type: "markdown",
    filename: "小C整理.md",
    mime_type: "text/markdown",
  })
  assert.equal(parseGeneratedFileRequest("导出成txt")?.type, "text")
  assert.equal(parseGeneratedFileRequest("把内容整理成 markdown 文件")?.type, "markdown")
  assert.equal(parseGeneratedFileRequest("请用 Markdown 回复"), null)
  assert.equal(parseGeneratedFileRequest("这段 Markdown 写得怎么样"), null)
})

test("uploads generated content and returns persistent attachment metadata", async () => {
  const uploads = []
  const supabase = {
    storage: {
      from(bucket) {
        return {
          async upload(path, buffer, options) {
            uploads.push({ bucket, path, buffer, options })
            return { error: null }
          },
        }
      },
    },
  }

  const attachment = await createGeneratedAttachment({
    supabase,
    user_id: "user",
    conversation_id: "chat_1",
    type: "markdown",
    content: "# 内容",
    filename: "内容.md",
  })

  assert.equal(attachment.type, "generated_file")
  assert.equal(attachment.name, "内容.md")
  assert.equal(attachment.mime_type, "text/markdown")
  assert.match(attachment.storage_path, /^user\/chat_1\/[0-9a-f-]+\/内容\.md$/)
  assert.equal("url" in attachment, false)
  assert.equal(uploads[0].bucket, "generated-files")
  assert.equal(uploads[0].options.contentType, "text/markdown")
})

test("upload failures do not produce attachment metadata", async () => {
  const supabase = {
    storage: {
      from() {
        return {
          async upload() {
            return { error: new Error("upload failed") }
          },
        }
      },
    },
  }

  await assert.rejects(
    createGeneratedAttachment({
      supabase,
      user_id: "user",
      conversation_id: "chat_1",
      type: "text",
      content: "内容",
      filename: "内容.txt",
    }),
    /upload failed/,
  )
})

test("normalizes persisted and app attachment metadata", () => {
  const metadata = {
    attachments: [{
      id: "attachment-1",
      name: "内容.txt",
      mime_type: "text/plain",
      size: 6,
      storage_path: "user/chat/attachment-1/内容.txt",
      type: "generated_file",
    }],
  }

  assert.deepEqual(normalizeGeneratedAttachments(metadata), metadata.attachments)
  assert.deepEqual(normalizeAppAttachments(metadata), metadata.attachments)
})

test("signs downloads only after resolving attachment metadata from its message", async () => {
  const metadata = {
    attachments: [{
      id: "attachment-1",
      name: "内容.txt",
      mime_type: "text/plain",
      size: 6,
      storage_path: "user/chat/attachment-1/内容.txt",
      type: "generated_file",
    }],
  }
  const filters = []
  const query = {
    select() { return this },
    eq(column, value) { filters.push([column, value]); return this },
    async maybeSingle() { return { data: { metadata }, error: null } },
  }
  const signed = []
  const supabase = {
    from(table) { assert.equal(table, "messages"); return query },
    storage: {
      from(bucket) {
        assert.equal(bucket, "generated-files")
        return {
          async createSignedUrl(path, expiresIn, options) {
            signed.push({ path, expiresIn, options })
            return { data: { signedUrl: "https://signed.example/file" }, error: null }
          },
        }
      },
    },
  }

  const result = await signGeneratedAttachmentDownload({
    supabase,
    user_id: "user",
    conversation_id: "chat",
    message_id: "message-1",
    attachment_id: "attachment-1",
  })

  assert.equal(result.url, "https://signed.example/file")
  assert.deepEqual(filters, [
    ["id", "message-1"],
    ["user_id", "user"],
    ["conversation_id", "chat"],
    ["role", "assistant"],
  ])
  assert.deepEqual(signed[0], {
    path: "user/chat/attachment-1/内容.txt",
    expiresIn: 300,
    options: { download: "内容.txt" },
  })
})

test("chat persistence, history restore, and signed download use attachment metadata", () => {
  const chat = fs.readFileSync(new URL("../api/chat.js", import.meta.url), "utf8")
  const history = fs.readFileSync(new URL("../api/history.js", import.meta.url), "utf8")
  const download = fs.readFileSync(new URL("../api/generated-files.js", import.meta.url), "utf8")
  const app = fs.readFileSync(new URL("../mobile/XiaoC/src/app/chat.tsx", import.meta.url), "utf8")

  assert.match(chat, /attachments\.length \? \{ attachments \} : \{\}/)
  assert.match(chat, /GENERATED FILE CREATE FAILED:[\s\S]*整理好的内容我先放在这里/)
  assert.match(history, /metadata: item\.metadata \|\| \{\}/)
  assert.match(download, /signGeneratedAttachmentDownload/)
  assert.match(app, /normalizeGeneratedAttachments\(item\.metadata\)/)
  assert.match(app, /FileSystem\.downloadAsync\(signed\.url, localUri\)/)
  assert.match(app, /Sharing\.shareAsync\(downloaded\.uri/)
})

import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  buildGeneratedFileChatOptions,
  buildGeneratedFileInstruction,
  createGeneratedAttachment,
  GENERATED_FILE_MAX_COMPLETION_TOKENS,
  generateFile,
  isGeneratedFileOutputComplete,
  normalizeGeneratedAttachments,
  parseGeneratedFileRequest,
  signGeneratedAttachmentDownload,
} from "../lib/generatedFiles.js"
import {
  normalizeGeneratedAttachments as normalizeAppAttachments,
} from "../mobile/XiaoC/src/lib/generatedAttachments.ts"

test("uses a high output budget only for generated files", () => {
  assert.deepEqual(buildGeneratedFileChatOptions(null, "chat-1"), {
    session_id: "chat-1",
  })
  assert.deepEqual(
    buildGeneratedFileChatOptions({ type: "markdown" }, "chat-1"),
    {
      session_id: "chat-1",
      max_completion_tokens: 8192,
    },
  )
  assert.equal(GENERATED_FILE_MAX_COMPLETION_TOKENS, 8192)
})

test("generated file instruction overrides ordinary short-chat style", () => {
  const instruction = buildGeneratedFileInstruction({
    type: "markdown",
    filename: "说明.md",
  })

  assert.match(instruction, /当前输出将直接作为文件正文/)
  assert.match(instruction, /不受日常聊天中“简短”“一句即可”“不要写完整文章”等表达风格约束/)
  assert.match(instruction, /完整覆盖她要求的内容/)
  assert.match(instruction, /不要为了符合聊天人格而主动缩短文档/)
})

test("treats finish_reason length as incomplete", () => {
  assert.equal(isGeneratedFileOutputComplete("length"), false)
  assert.equal(isGeneratedFileOutputComplete("stop"), true)
  assert.equal(isGeneratedFileOutputComplete(null), true)
})

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

test("recognizes explicit delivery intent and resolves its requested format", () => {
  assert.deepEqual(parseGeneratedFileRequest("生成一个 md 文件"), {
    type: "markdown",
    filename: "小C整理.md",
    mime_type: "text/markdown",
  })
  assert.equal(parseGeneratedFileRequest("导出成txt")?.type, "text")
  assert.equal(parseGeneratedFileRequest("把内容整理成 markdown 文件")?.type, "markdown")
  assert.equal(parseGeneratedFileRequest("写一个文档")?.type, "markdown")
  assert.equal(parseGeneratedFileRequest("整理成一份文档")?.type, "markdown")
  assert.equal(parseGeneratedFileRequest("做成文件给我")?.type, "markdown")
  assert.equal(parseGeneratedFileRequest("导出一份记录")?.type, "markdown")
  assert.equal(parseGeneratedFileRequest("整理成一份文档，文件名叫旅行计划")?.filename, "旅行计划.md")
  assert.equal(parseGeneratedFileRequest("生成一个叫说明书的文档")?.filename, "说明书.md")
})

test("does not confuse content writing or Markdown formatting with file delivery", () => {
  const normalChatRequests = [
    "写一段文字",
    "帮我回复这句话",
    "用 Markdown 格式回答",
    "解释 Markdown",
    "总结一下",
    "帮我写一下这个",
    "帮我改一下文案",
    "写个标题",
  ]

  for (const request of normalChatRequests) {
    assert.equal(parseGeneratedFileRequest(request), null, request)
  }
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
  const download = fs.readFileSync(new URL("../api/memory.js", import.meta.url), "utf8")
  const app = fs.readFileSync(new URL("../mobile/XiaoC/src/app/chat.tsx", import.meta.url), "utf8")

  assert.match(chat, /attachments\.length \? \{ attachments \} : \{\}/)
  assert.match(chat, /const assistantMessageId = await saveMessage\([\s\S]*attachments\.length \? \{ attachments \} : \{\}/)
  assert.match(chat, /GENERATED FILE CREATE FAILED:[\s\S]*整理好的内容我先放在这里/)
  assert.match(chat, /if \(!isGeneratedFileOutputComplete\(llm\.finishReason\)\)[\s\S]*else try[\s\S]*createGeneratedAttachment/)
  assert.match(chat, /没有把它当成完整文件交付/)
  assert.match(history, /metadata: item\.metadata \|\| \{\}/)
  assert.match(download, /signGeneratedAttachmentDownload/)
  assert.match(download, /type === "generated_file"/)
  assert.match(app, /"\/api\/memory"[\s\S]*type: "generated_file"[\s\S]*action: "sign_download"/)
  assert.match(app, /normalizeGeneratedAttachments\(item\.metadata\)/)
  assert.match(app, /FileSystem\.downloadAsync\(signed\.url, localUri\)/)
  assert.match(app, /Sharing\.shareAsync\(downloaded\.uri/)
})

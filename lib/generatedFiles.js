import { randomUUID } from "node:crypto"

export const GENERATED_FILES_BUCKET = "generated-files"

const GENERATED_FILE_TYPES = {
  markdown: { extension: "md", mimeType: "text/markdown" },
  text: { extension: "txt", mimeType: "text/plain" },
}

function sanitizeFilenamePart(value, fallback) {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 100)

  return cleaned || fallback
}

function sanitizePathPart(value, fallback) {
  return sanitizeFilenamePart(value, fallback).replace(/\s+/g, "-")
}

export function parseGeneratedFileRequest(message) {
  const text = String(message || "").trim()
  if (!text) return null

  const hasMarkdownFormat = /markdown/i.test(text) || /(?:^|[^a-z])md(?=$|[^a-z])/i.test(text)
  const hasTextFormat = /纯文本/.test(text) || /(?:^|[^a-z])(?:text|txt)(?=$|[^a-z])/i.test(text)
  const type = hasMarkdownFormat && !hasTextFormat
    ? "markdown"
    : hasTextFormat && !hasMarkdownFormat
      ? "text"
      : null
  if (!type) return null

  const hasExplicitFileAction = /(生成|创建|导出|保存|下载|整理成|做成|制成|转成|转换成|输出成)/.test(text)
  const explicitlyNamesFile = /文件/.test(text) || /\.(?:md|txt)(?=$|[\s，。；：,:])/i.test(text)

  if (!hasExplicitFileAction || (!explicitlyNamesFile && !/(导出|下载|保存)/.test(text))) {
    return null
  }

  const explicitFilename = text.match(/(?:文件名(?:叫|为|是)?|命名为)\s*[「“"']?([^「」“”"'\n]+?\.(?:md|txt))[」”"']?/i)?.[1] ||
    text.match(/[「“"']([^「」“”"'\n]+?\.(?:md|txt))[」”"']/i)?.[1]
  const spec = GENERATED_FILE_TYPES[type]
  const baseName = explicitFilename
    ? sanitizeFilenamePart(explicitFilename, `小C整理.${spec.extension}`)
    : `小C整理.${spec.extension}`
  const nameWithoutExtension = baseName.replace(/\.(?:md|txt)$/i, "")

  return {
    type,
    filename: `${nameWithoutExtension}.${spec.extension}`,
    mime_type: spec.mimeType,
  }
}

export function buildGeneratedFileInstruction(request) {
  if (!request) return ""

  return `【Generated File｜本轮文件生成】
她明确要求生成 ${request.filename}。
请直接输出文件内应保存的完整正文，不要输出下载链接，不要声称已经上传，不要使用包裹全文的代码围栏。
${request.type === "text" ? "这是纯文本文件，不要使用 Markdown 标题、列表符号或强调语法。" : "这是 Markdown 文件，可以使用自然且清晰的 Markdown 结构。"}`
}

export function generateFile({ type, content, filename, options = {} }) {
  const spec = GENERATED_FILE_TYPES[type]
  if (!spec) throw new Error(`Unsupported generated file type: ${type}`)

  const normalizedContent = String(content || "").replace(/\r\n?/g, "\n")
  if (!normalizedContent.trim()) throw new Error("Generated file content is empty")

  const fallback = `小C整理.${spec.extension}`
  const safeFilename = sanitizeFilenamePart(filename, fallback)
  const nameWithoutExtension = safeFilename.replace(/\.(?:md|txt)$/i, "")
  const name = `${nameWithoutExtension}.${spec.extension}`
  const buffer = Buffer.from(normalizedContent, options.encoding || "utf8")

  return {
    name,
    mime_type: spec.mimeType,
    size: buffer.byteLength,
    buffer,
  }
}

export async function createGeneratedAttachment({
  supabase,
  user_id,
  conversation_id,
  type,
  content,
  filename,
  options,
}) {
  const generated = generateFile({ type, content, filename, options })
  const id = randomUUID()
  const storagePath = [
    sanitizePathPart(user_id, "user"),
    sanitizePathPart(conversation_id, "conversation"),
    id,
    generated.name,
  ].join("/")
  const { error } = await supabase.storage
    .from(GENERATED_FILES_BUCKET)
    .upload(storagePath, generated.buffer, {
      contentType: generated.mime_type,
      upsert: false,
    })

  if (error) throw error

  return {
    id,
    name: generated.name,
    mime_type: generated.mime_type,
    size: generated.size,
    storage_path: storagePath,
    type: "generated_file",
  }
}

export function normalizeGeneratedAttachments(metadata) {
  const attachments = Array.isArray(metadata?.attachments) ? metadata.attachments : []

  return attachments.filter(item =>
    item?.type === "generated_file" &&
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.mime_type === "string" &&
    Number.isFinite(Number(item.size)) &&
    typeof item.storage_path === "string"
  ).map(item => ({
    id: item.id,
    name: item.name,
    mime_type: item.mime_type,
    size: Number(item.size),
    storage_path: item.storage_path,
    type: "generated_file",
  }))
}

export async function signGeneratedAttachmentDownload({
  supabase,
  user_id,
  conversation_id,
  message_id,
  attachment_id,
  expiresIn = 5 * 60,
}) {
  const { data: message, error: messageError } = await supabase
    .from("messages")
    .select("metadata")
    .eq("id", message_id)
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .eq("role", "assistant")
    .maybeSingle()

  if (messageError) throw messageError

  const attachment = normalizeGeneratedAttachments(message?.metadata)
    .find(item => item.id === attachment_id)
  if (!attachment) {
    const error = new Error("Attachment not found")
    error.code = "ATTACHMENT_NOT_FOUND"
    throw error
  }

  const { data, error } = await supabase.storage
    .from(GENERATED_FILES_BUCKET)
    .createSignedUrl(attachment.storage_path, expiresIn, {
      download: attachment.name,
    })

  if (error) throw error

  return {
    url: data.signedUrl,
    expires_in: expiresIn,
    attachment: {
      id: attachment.id,
      name: attachment.name,
      mime_type: attachment.mime_type,
      size: attachment.size,
      type: attachment.type,
    },
  }
}

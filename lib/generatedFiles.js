import { randomUUID } from "node:crypto"

export const GENERATED_FILES_BUCKET = "generated-files"
export const GENERATED_FILE_MAX_COMPLETION_TOKENS = 8192

const GENERATED_FILE_TYPES = {
  markdown: { extension: "md", mimeType: "text/markdown" },
  text: { extension: "txt", mimeType: "text/plain" },
}

const DELIVERY_INTENT_PATTERNS = [
  /(?:生成|创建).{0,8}(?:文件|文档|附件)/,
  /写(?:一份|一个|份|个)?[^，。！？\n]{0,8}文档/,
  /(?:整理|做|制|转|转换|输出).{0,6}(?:成|为).{0,20}(?:文件|文档|附件|一份)/i,
  /(?:文件|文档|附件).{0,6}(?:给我|发我|交给我|提供给我)/,
  /(?:导出|保存为|另存为).{0,10}(?:文件|文档|附件|版本|记录|md|markdown|txt|纯文本|一份|一个)/i,
  /生成.{0,4}附件/,
  /(?:给我|发我|提供).{0,8}(?:可下载|能下载)(?:的)?版本/,
]

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

  const hasDeliveryIntent = DELIVERY_INTENT_PATTERNS.some(pattern => pattern.test(text))
  if (!hasDeliveryIntent) return null

  const hasMarkdownFormat = /markdown/i.test(text) || /(?:^|[^a-z])md(?=$|[^a-z])/i.test(text)
  const hasTextFormat = /纯文本/.test(text) || /(?:^|[^a-z])(?:text|txt)(?=$|[^a-z])/i.test(text)
  if (hasMarkdownFormat && hasTextFormat) return null

  const type = hasMarkdownFormat
    ? "markdown"
    : hasTextFormat
      ? "text"
      : "markdown"

  const explicitFilename = text.match(/(?:文件名|文档名|名称)(?:叫|为|是)?\s*[「“"']?([^，。；！？「」“”"'\n]+?)(?:[」”"']|$)/i)?.[1] ||
    text.match(/(?:叫|名为|命名为)\s*[「“"']?([^，。；！？「」“”"'\n]+?)[」”"']?(?:的)?(?:文件|文档)/i)?.[1] ||
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
当前输出将直接作为文件正文。文件长度由她的实际要求决定，不受日常聊天中“简短”“一句即可”“不要写完整文章”等表达风格约束。
请完整覆盖她要求的内容，不要为了符合聊天人格而主动缩短文档。
请直接输出文件内应保存的完整正文，不要输出下载链接，不要声称已经上传，不要使用包裹全文的代码围栏。
${request.type === "text" ? "这是纯文本文件，不要使用 Markdown 标题、列表符号或强调语法。" : "这是 Markdown 文件，可以使用自然且清晰的 Markdown 结构。"}`
}

export function buildGeneratedFileChatOptions(request, sessionId) {
  return request
    ? {
        session_id: sessionId,
        max_completion_tokens: GENERATED_FILE_MAX_COMPLETION_TOKENS,
      }
    : { session_id: sessionId }
}

export function isGeneratedFileOutputComplete(finishReason) {
  return String(finishReason || "").toLowerCase() !== "length"
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

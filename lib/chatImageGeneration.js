import { randomUUID } from "node:crypto"
import {
  AI_ENDPOINTS,
  AI_MODELS,
  CHAT_IMAGE_POLICY,
} from "./aiConfig.js"
import { GENERATED_FILES_BUCKET } from "./generatedFiles.js"

export const CHAT_IMAGE_TOOL_NAME = "create_chat_image"

export const CHAT_IMAGE_TOOL = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: CHAT_IMAGE_TOOL_NAME,
    description: "Generate one image, or edit an image the user currently supplied or explicitly referenced. Use only when an image should actually be created, never for ordinary image discussion.",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["mode", "instruction"],
      properties: Object.freeze({
        mode: Object.freeze({ type: "string", enum: ["generate", "edit"] }),
        instruction: Object.freeze({
          type: "string",
          description: "A self-contained visual instruction for the image model, without private conversation history.",
        }),
        source_message_id: Object.freeze({
          type: "string",
          description: "For editing an older explicitly referenced chat image, its message id. Omit to edit the image in the current user turn.",
        }),
      }),
    }),
  }),
})

export function buildMainChatImageToolOptions(sessionId, baseOptions = {}) {
  return {
    ...baseOptions,
    session_id: sessionId,
    tools: [CHAT_IMAGE_TOOL],
    tool_choice: "auto",
  }
}

export function parseChatImageToolCall(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  const call = calls.find(item => item?.function?.name === CHAT_IMAGE_TOOL_NAME)
  if (!call) return null

  let args
  try {
    args = JSON.parse(call.function.arguments || "{}")
  } catch {
    return { id: call.id, error: "invalid_tool_arguments" }
  }

  const mode = args?.mode === "edit" ? "edit" : args?.mode === "generate" ? "generate" : null
  const instruction = String(args?.instruction || "").trim().slice(0, CHAT_IMAGE_POLICY.maxInstructionChars)
  if (!mode || !instruction) return { id: call.id, error: "invalid_tool_arguments" }

  return {
    id: String(call.id || randomUUID()),
    mode,
    instruction,
    sourceMessageId: String(args?.source_message_id || "").trim().slice(0, 160) || null,
    raw: call,
  }
}

function readDataImage(value) {
  const match = String(value || "").match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/)
  if (!match) return null
  const bytes = Buffer.from(match[2], "base64")
  if (!bytes.length || bytes.byteLength > CHAT_IMAGE_POLICY.maxSourceBytes) return null
  return `data:${match[1]};base64,${bytes.toString("base64")}`
}

function findGeneratedImage(metadata) {
  return (Array.isArray(metadata?.attachments) ? metadata.attachments : []).find(item =>
    item?.type === "generated_image" &&
    typeof item.storage_path === "string" &&
    item.storage_path.length > 0
  ) || null
}

export async function resolveAuthorizedSourceImage({
  supabase,
  userId,
  conversationId,
  currentUserMessageId,
  sourceMessageId,
}) {
  const messageId = sourceMessageId || currentUserMessageId
  if (!messageId) throw Object.assign(new Error("Source image is required"), { code: "SOURCE_IMAGE_REQUIRED" })

  const { data: message, error } = await supabase
    .from("messages")
    .select("id,role,metadata")
    .eq("id", messageId)
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .in("role", ["user", "assistant"])
    .maybeSingle()
  if (error) throw error
  if (!message) throw Object.assign(new Error("Source image is not accessible"), { code: "SOURCE_IMAGE_UNAUTHORIZED" })

  const inline = readDataImage(message.metadata?.imageUrls?.[0] || message.metadata?.imageUrl)
  if (inline) return inline

  const generated = findGeneratedImage(message.metadata)
  if (!generated) throw Object.assign(new Error("Source image is not accessible"), { code: "SOURCE_IMAGE_UNAUTHORIZED" })

  const expectedPrefix = `${String(userId).replace(/[^a-zA-Z0-9._-]/g, "-")}/${String(conversationId).replace(/[^a-zA-Z0-9._-]/g, "-")}/`
  if (!generated.storage_path.startsWith(expectedPrefix)) {
    throw Object.assign(new Error("Source image is not accessible"), { code: "SOURCE_IMAGE_UNAUTHORIZED" })
  }

  const { data, error: signError } = await supabase.storage
    .from(GENERATED_FILES_BUCKET)
    .createSignedUrl(generated.storage_path, 5 * 60)
  if (signError || !data?.signedUrl) throw signError || new Error("Source image signing failed")
  return data.signedUrl
}

export function buildImageProviderRequest({ instruction, sourceImage = null }) {
  return {
    model: AI_MODELS.imageGeneration,
    prompt: String(instruction || "").trim().slice(0, CHAT_IMAGE_POLICY.maxInstructionChars),
    n: CHAT_IMAGE_POLICY.count,
    quality: CHAT_IMAGE_POLICY.quality,
    aspect_ratio: CHAT_IMAGE_POLICY.aspectRatio,
    ...(sourceImage
      ? { input_references: [{ type: "image_url", image_url: { url: sourceImage } }] }
      : {}),
  }
}

function normalizeImageResult(data) {
  const first = Array.isArray(data?.data) ? data.data[0] : null
  const encoded = String(first?.b64_json || "")
  const mimeType = String(first?.media_type || "image/png").toLowerCase()
  if (!encoded || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    throw new Error("Image provider returned no supported image")
  }
  const buffer = Buffer.from(encoded, "base64")
  if (!buffer.length || buffer.byteLength > CHAT_IMAGE_POLICY.maxSourceBytes) {
    throw new Error("Image provider returned an invalid image size")
  }
  return { buffer, mimeType, usage: data?.usage || {} }
}

export async function generateChatImage({ instruction, sourceImage = null, fetchImpl = fetch }) {
  const response = await fetchImpl(AI_ENDPOINTS.openRouterImages, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildImageProviderRequest({ instruction, sourceImage })),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `OpenRouter image request failed: ${response.status}`)
  }
  return normalizeImageResult(data)
}

export async function persistGeneratedChatImage({
  supabase,
  userId,
  conversationId,
  generated,
}) {
  const id = randomUUID()
  const extension = generated.mimeType === "image/jpeg" ? "jpg" : generated.mimeType.split("/")[1]
  const safeUser = String(userId).replace(/[^a-zA-Z0-9._-]/g, "-") || "user"
  const safeConversation = String(conversationId).replace(/[^a-zA-Z0-9._-]/g, "-") || "conversation"
  const storagePath = `${safeUser}/${safeConversation}/${id}/xiaoc-image.${extension}`
  const { error } = await supabase.storage.from(GENERATED_FILES_BUCKET).upload(
    storagePath,
    generated.buffer,
    { contentType: generated.mimeType, upsert: false },
  )
  if (error) throw error
  return {
    id,
    name: `xiaoc-image.${extension}`,
    mime_type: generated.mimeType,
    size: generated.buffer.byteLength,
    storage_path: storagePath,
    type: "generated_image",
  }
}

export function buildImageToolResult({ ok, attachment = null, error = null }) {
  return JSON.stringify(ok
    ? { status: "ok", image_created: true, attachment_id: attachment.id }
    : { status: "error", error: String(error || "image_generation_failed").slice(0, 160) })
}

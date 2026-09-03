import { createHash, randomUUID } from "node:crypto"
import { GENERATED_FILES_BUCKET } from "./generatedFiles.js"

export const MESSAGE_VOICE_MAX_TEXT_CHARS = 4000

function safePathPart(value, fallback) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
  return normalized || fallback
}

export function normalizeMessageVoiceAsset(metadata) {
  const voice = metadata?.voice
  if (
    voice?.status !== "ready" ||
    typeof voice.id !== "string" ||
    typeof voice.storage_path !== "string" ||
    typeof voice.mime_type !== "string" ||
    typeof voice.content_hash !== "string" ||
    !Number.isFinite(Number(voice.size))
  ) {
    return null
  }

  return {
    id: voice.id,
    status: "ready",
    storage_path: voice.storage_path,
    mime_type: voice.mime_type,
    size: Number(voice.size),
    duration_seconds: Number.isFinite(Number(voice.duration_seconds))
      ? Math.max(0, Number(voice.duration_seconds))
      : null,
    provider: typeof voice.provider === "string" ? voice.provider : null,
    voice_id: typeof voice.voice_id === "string" ? voice.voice_id : null,
    voice_version: typeof voice.voice_version === "string" ? voice.voice_version : null,
    content_hash: voice.content_hash,
    created_at: typeof voice.created_at === "string" ? voice.created_at : null,
  }
}

export function buildMessageVoiceContentHash(content) {
  return createHash("sha256").update(String(content || ""), "utf8").digest("hex")
}

export function buildMessageVoiceStoragePath({ user_id, conversation_id, message_id, extension }) {
  return [
    safePathPart(user_id, "user"),
    safePathPart(conversation_id, "conversation"),
    "message-voice",
    safePathPart(message_id, "message"),
    `${randomUUID()}.${safePathPart(extension, "audio")}`,
  ].join("/")
}

async function loadAssistantMessage({ supabase, user_id, conversation_id, message_id }) {
  const { data, error } = await supabase
    .from("messages")
    .select("id, content, metadata")
    .eq("id", message_id)
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .eq("role", "assistant")
    .maybeSingle()

  if (error) throw error
  if (!data) {
    const error = new Error("Assistant message not found")
    error.code = "MESSAGE_NOT_FOUND"
    throw error
  }
  return data
}

export async function signMessageVoicePlayback({
  supabase,
  user_id,
  conversation_id,
  message_id,
  expiresIn = 5 * 60,
}) {
  const message = await loadAssistantMessage({ supabase, user_id, conversation_id, message_id })
  const asset = normalizeMessageVoiceAsset(message.metadata)
  if (!asset || asset.content_hash !== buildMessageVoiceContentHash(message.content)) {
    const error = new Error("Message voice not found")
    error.code = "VOICE_NOT_FOUND"
    throw error
  }

  const { data, error } = await supabase.storage
    .from(GENERATED_FILES_BUCKET)
    .createSignedUrl(asset.storage_path, expiresIn)
  if (error) throw error

  return { url: data.signedUrl, expires_in: expiresIn, voice: asset }
}

// Provider-neutral persistence boundary. ElevenLabs or MiniMax only needs to
// return synthesized bytes and identity metadata to this function.
export async function saveMessageVoice({
  supabase,
  user_id,
  conversation_id,
  message_id,
  synthesis,
}) {
  const message = await loadAssistantMessage({ supabase, user_id, conversation_id, message_id })
  const content = String(message.content || "").trim()
  if (!content || content.length > MESSAGE_VOICE_MAX_TEXT_CHARS) {
    const error = new Error(content ? "Message is too long for voice" : "Message has no speakable text")
    error.code = content ? "VOICE_TEXT_TOO_LONG" : "VOICE_TEXT_EMPTY"
    throw error
  }
  if (!Buffer.isBuffer(synthesis?.buffer) || !synthesis.buffer.length) {
    throw new Error("Voice provider returned no audio")
  }

  const storagePath = buildMessageVoiceStoragePath({
    user_id,
    conversation_id,
    message_id,
    extension: synthesis.extension,
  })
  const { error: uploadError } = await supabase.storage
    .from(GENERATED_FILES_BUCKET)
    .upload(storagePath, synthesis.buffer, {
      contentType: synthesis.mime_type,
      upsert: false,
    })
  if (uploadError) throw uploadError

  const voice = {
    id: randomUUID(),
    status: "ready",
    storage_path: storagePath,
    mime_type: synthesis.mime_type,
    size: synthesis.buffer.byteLength,
    duration_seconds: Number.isFinite(Number(synthesis.duration_seconds))
      ? Math.max(0, Number(synthesis.duration_seconds))
      : null,
    provider: synthesis.provider,
    voice_id: synthesis.voice_id,
    voice_version: synthesis.voice_version || null,
    content_hash: buildMessageVoiceContentHash(message.content),
    created_at: new Date().toISOString(),
  }

  const latest = await loadAssistantMessage({ supabase, user_id, conversation_id, message_id })
  const { error: updateError } = await supabase
    .from("messages")
    .update({ metadata: { ...(latest.metadata || {}), voice } })
    .eq("id", message_id)
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .eq("role", "assistant")
  if (updateError) throw updateError

  return voice
}

export async function prepareMessageVoicePlayback({
  supabase,
  user_id,
  conversation_id,
  message_id,
  synthesize,
  expiresIn = 5 * 60,
}) {
  try {
    return await signMessageVoicePlayback({
      supabase, user_id, conversation_id, message_id, expiresIn,
    })
  } catch (error) {
    if (error?.code !== "VOICE_NOT_FOUND") throw error
  }

  if (typeof synthesize !== "function") {
    const error = new Error("Voice provider is not configured")
    error.code = "VOICE_PROVIDER_NOT_CONFIGURED"
    throw error
  }

  const message = await loadAssistantMessage({ supabase, user_id, conversation_id, message_id })
  const content = String(message.content || "").trim()
  if (!content || content.length > MESSAGE_VOICE_MAX_TEXT_CHARS) {
    const error = new Error(content ? "Message is too long for voice" : "Message has no speakable text")
    error.code = content ? "VOICE_TEXT_TOO_LONG" : "VOICE_TEXT_EMPTY"
    throw error
  }

  const synthesis = await synthesize({ text: content, message_id, conversation_id, user_id })
  await saveMessageVoice({ supabase, user_id, conversation_id, message_id, synthesis })
  return signMessageVoicePlayback({
    supabase, user_id, conversation_id, message_id, expiresIn,
  })
}

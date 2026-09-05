import { randomUUID } from "node:crypto"
import { GENERATED_FILES_BUCKET } from "./generatedFiles.js"

export const USER_VOICE_MAX_BYTES = 3 * 1024 * 1024
export const USER_VOICE_MAX_DURATION_SECONDS = 60
const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
const GROQ_WHISPER_LARGE_V3_USD_PER_HOUR = 0.111

function safePathPart(value, fallback) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
  return normalized || fallback
}

function allowedMimeType(value) {
  const mime = String(value || "").toLowerCase()
  return ["audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "audio/wav", "audio/webm"].includes(mime)
    ? mime
    : "audio/mp4"
}

function extensionForMimeType(mimeType) {
  if (mimeType.includes("wav")) return "wav"
  if (mimeType.includes("webm")) return "webm"
  if (mimeType.includes("aac")) return "aac"
  return "m4a"
}

export function normalizeUserVoiceAsset(value) {
  if (
    value?.status !== "ready" ||
    typeof value.id !== "string" ||
    typeof value.storage_path !== "string" ||
    typeof value.mime_type !== "string" ||
    !Number.isFinite(Number(value.size))
  ) return null

  return {
    id: value.id,
    status: "ready",
    storage_path: value.storage_path,
    mime_type: value.mime_type,
    size: Number(value.size),
    duration_seconds: Number.isFinite(Number(value.duration_seconds))
      ? Math.max(0, Number(value.duration_seconds))
      : null,
    provider: value.provider === "groq" ? "groq" : null,
    model: typeof value.model === "string" ? value.model : null,
    language: typeof value.language === "string" ? value.language : null,
    estimated_cost_usd: Number.isFinite(Number(value.estimated_cost_usd))
      ? Math.max(0, Number(value.estimated_cost_usd))
      : null,
    created_at: typeof value.created_at === "string" ? value.created_at : null,
  }
}

export function formatUserVoiceForPrompt(content, value, { current = false } = {}) {
  const voice = normalizeUserVoiceAsset(value)
  const text = String(content || "")
  if (!voice) return text

  const duration = Math.max(1, Math.round(Number(voice.duration_seconds) || 0))
  return current
    ? `【本轮语音消息｜约${duration}秒】\n她刚刚通过语音亲口说了下面内容。以下是语音转写：\n${text}`
    : `[她通过语音说，约${duration}秒；以下为转写]\n${text}`
}

export function estimateGroqTranscriptionCost(durationSeconds) {
  const billedSeconds = Math.max(10, Number(durationSeconds) || 0)
  return Number(((billedSeconds / 3600) * GROQ_WHISPER_LARGE_V3_USD_PER_HOUR).toFixed(8))
}

export async function transcribeAndStoreUserVoice({
  supabase,
  user_id,
  conversation_id,
  audio_base64,
  mime_type,
  duration_seconds,
  fetchImpl = fetch,
}) {
  const duration = Number(duration_seconds)
  if (!Number.isFinite(duration) || duration <= 0 || duration > USER_VOICE_MAX_DURATION_SECONDS) {
    const error = new Error("Voice duration is invalid")
    error.code = "USER_VOICE_DURATION_INVALID"
    throw error
  }

  const buffer = Buffer.from(String(audio_base64 || ""), "base64")
  if (!buffer.length || buffer.length > USER_VOICE_MAX_BYTES) {
    const error = new Error("Voice file is empty or too large")
    error.code = "USER_VOICE_FILE_INVALID"
    throw error
  }

  const apiKey = String(process.env.GROQ_API_KEY || "").trim()
  if (!apiKey) {
    const error = new Error("Groq is not configured")
    error.code = "GROQ_NOT_CONFIGURED"
    throw error
  }

  const model = String(process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3").trim()
  const mimeType = allowedMimeType(mime_type)
  const extension = extensionForMimeType(mimeType)
  const form = new FormData()
  form.append("file", new Blob([buffer], { type: mimeType }), `voice.${extension}`)
  form.append("model", model)
  form.append("language", "zh")
  form.append("response_format", "verbose_json")
  form.append("temperature", "0")
  form.append("prompt", "小C，大天使长，小天使，老婆，宝宝，榴莲，Codex，OpenRouter，MiniMax，TestFlight，debug")

  const response = await fetchImpl(GROQ_TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Groq transcription failed: ${response.status}`)
    error.code = "GROQ_TRANSCRIPTION_FAILED"
    throw error
  }

  const transcript = String(data?.text || "").trim()
  const reportedDuration = Number(data?.duration)
  const providerDuration = Number.isFinite(reportedDuration) && reportedDuration > 0
    ? reportedDuration
    : duration
  if (!transcript || providerDuration < 0.6) {
    const error = new Error("No speech was recognized")
    error.code = "USER_VOICE_EMPTY_TRANSCRIPT"
    error.diagnostics = {
      client_duration_seconds: duration,
      provider_duration_seconds: Number.isFinite(reportedDuration) ? reportedDuration : null,
      audio_bytes: buffer.byteLength,
      transcript_chars: transcript.length,
    }
    throw error
  }

  const storagePath = [
    safePathPart(user_id, "user"),
    safePathPart(conversation_id, "conversation"),
    "user-voice",
    `${randomUUID()}.${extension}`,
  ].join("/")
  const { error: uploadError } = await supabase.storage
    .from(GENERATED_FILES_BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType, upsert: false })
  if (uploadError) throw uploadError

  const voice = {
    id: randomUUID(),
    status: "ready",
    storage_path: storagePath,
    mime_type: mimeType,
    size: buffer.byteLength,
    duration_seconds: providerDuration,
    provider: "groq",
    model,
    language: data?.language || "zh",
    estimated_cost_usd: estimateGroqTranscriptionCost(providerDuration),
    created_at: new Date().toISOString(),
  }
  return { transcript, voice }
}

export async function signUserVoicePlayback({
  supabase,
  user_id,
  conversation_id,
  message_id,
  expiresIn = 5 * 60,
}) {
  const { data: message, error } = await supabase
    .from("messages")
    .select("metadata")
    .eq("id", message_id)
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .eq("role", "user")
    .maybeSingle()
  if (error) throw error
  const voice = normalizeUserVoiceAsset(message?.metadata?.userVoice)
  if (!voice) {
    const error = new Error("User voice not found")
    error.code = "USER_VOICE_NOT_FOUND"
    throw error
  }
  const { data, error: signError } = await supabase.storage
    .from(GENERATED_FILES_BUCKET)
    .createSignedUrl(voice.storage_path, expiresIn)
  if (signError) throw signError
  return { url: data.signedUrl, expires_in: expiresIn, voice }
}

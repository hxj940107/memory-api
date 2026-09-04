import { createHash } from "node:crypto"

const DEFAULT_BASE_URL = "https://api.minimax.cn"

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback
}

export function buildMiniMaxSpeechText(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`#>]+/g, "")
    .replace(/(^|[\s，。！？；])哈{3,}(?=$|[\s，。！？；])/g, "$1(laughs)")
    .replace(/哈{2,}/g, "(chuckle)")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function getMiniMaxSpeechConfig(env = process.env) {
  if (String(env.MESSAGE_VOICE_PROVIDER || "").trim().toLowerCase() !== "minimax") {
    return null
  }

  const apiKey = String(env.MINIMAX_API_KEY || "").trim()
  const voiceId = String(env.MINIMAX_VOICE_ID || "").trim()
  if (!apiKey || !voiceId) return null

  const model = String(env.MINIMAX_SPEECH_MODEL || "speech-2.8-hd").trim()
  const speed = boundedNumber(env.MINIMAX_SPEECH_SPEED, 1.115, 0.5, 2)
  const pitch = Math.round(boundedNumber(env.MINIMAX_SPEECH_PITCH, 0, -12, 12))
  const volume = boundedNumber(env.MINIMAX_SPEECH_VOLUME, 1, 0.01, 10)
  const languageBoost = String(env.MINIMAX_LANGUAGE_BOOST || "Chinese").trim()
  const baseUrl = String(env.MINIMAX_API_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "")
  const version = createHash("sha256")
    .update(JSON.stringify({ provider: "minimax", model, voiceId, speed, pitch, volume, languageBoost }))
    .digest("hex")
    .slice(0, 16)

  return { apiKey, voiceId, model, speed, pitch, volume, languageBoost, baseUrl, version }
}

export function createMiniMaxSpeechSynthesizer({ env = process.env, fetchImpl = fetch } = {}) {
  const config = getMiniMaxSpeechConfig(env)
  if (!config) return null

  return {
    voiceVersion: config.version,
    async synthesize({ text }) {
      const speechText = buildMiniMaxSpeechText(text)
      if (!speechText) {
        const error = new Error("Message has no speakable text")
        error.code = "VOICE_TEXT_EMPTY"
        throw error
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30_000)
      let response
      try {
        response = await fetchImpl(`${config.baseUrl}/v1/t2a_v2`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            text: speechText,
            stream: false,
            voice_setting: {
              voice_id: config.voiceId,
              speed: config.speed,
              vol: config.volume,
              pitch: config.pitch,
            },
            audio_setting: {
              sample_rate: 32000,
              bitrate: 128000,
              format: "mp3",
              channel: 1,
            },
            language_boost: config.languageBoost,
            output_format: "hex",
            subtitle_enable: false,
          }),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }

      const payload = await response.json().catch(() => null)
      const statusCode = Number(payload?.base_resp?.status_code)
      const audioHex = payload?.data?.audio
      if (
        !response.ok ||
        statusCode !== 0 ||
        typeof audioHex !== "string" ||
        !audioHex.length ||
        audioHex.length % 2 !== 0 ||
        !/^[0-9a-f]+$/i.test(audioHex)
      ) {
        const error = new Error(payload?.base_resp?.status_msg || `MiniMax speech failed (${response.status})`)
        error.code = "VOICE_PROVIDER_FAILED"
        error.provider_status = Number.isFinite(statusCode) ? statusCode : null
        throw error
      }

      return {
        buffer: Buffer.from(audioHex, "hex"),
        mime_type: "audio/mpeg",
        extension: "mp3",
        duration_seconds: Number.isFinite(Number(payload?.extra_info?.audio_length))
          ? Number(payload.extra_info.audio_length) / 1000
          : null,
        provider: "minimax",
        voice_id: config.voiceId,
        voice_version: config.version,
      }
    },
  }
}


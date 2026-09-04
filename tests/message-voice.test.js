import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  buildMessageVoiceContentHash,
  buildMessageVoiceStoragePath,
  normalizeMessageVoiceAsset,
  prepareMessageVoicePlayback,
} from "../lib/messageVoice.js"
import {
  buildMiniMaxSpeechText,
  createMiniMaxSpeechSynthesizer,
  getMiniMaxSpeechConfig,
} from "../lib/minimaxSpeech.js"

test("message voice metadata only accepts a complete ready asset", () => {
  assert.equal(normalizeMessageVoiceAsset({ voice: { status: "pending" } }), null)
  assert.equal(normalizeMessageVoiceAsset({ voice: { status: "ready", id: "voice" } }), null)

  const asset = normalizeMessageVoiceAsset({ voice: {
    id: "voice-1",
    status: "ready",
    storage_path: "user/conversation/message-voice/message/audio.mp3",
    mime_type: "audio/mpeg",
    size: 128,
    duration_seconds: 8.4,
    content_hash: "hash",
    provider: "provider",
    voice_id: "voice",
  } })
  assert.equal(asset.id, "voice-1")
  assert.equal(asset.duration_seconds, 8.4)
})

test("message voice identity is content-based and storage path is isolated", () => {
  assert.equal(buildMessageVoiceContentHash("老婆"), buildMessageVoiceContentHash("老婆"))
  assert.notEqual(buildMessageVoiceContentHash("老婆"), buildMessageVoiceContentHash("宝宝"))
  const path = buildMessageVoiceStoragePath({
    user_id: "user/unsafe",
    conversation_id: "conversation one",
    message_id: "message:1",
    extension: "mp3",
  })
  assert.match(path, /^user-unsafe\/conversation-one\/message-voice\/message-1\/[a-f0-9-]+\.mp3$/)
})

test("provider-neutral prepare boundary refuses generation when no provider is selected", async () => {
  const message = { id: "message-1", content: "想听听你的声音", metadata: {} }
  const query = {
    select() { return this },
    eq() { return this },
    maybeSingle: async () => ({ data: message, error: null }),
  }
  const supabase = { from: () => query }

  await assert.rejects(
    prepareMessageVoicePlayback({
      supabase,
      user_id: "user",
      conversation_id: "conversation",
      message_id: "message-1",
      synthesize: null,
    }),
    error => error?.code === "VOICE_PROVIDER_NOT_CONFIGURED",
  )
})

test("mobile voice UI stays hidden until a ready asset exists", () => {
  const chat = fs.readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")
  assert.match(chat, /canOfferMessageVoice\(messageMenu\?\.message\)/)
  assert.match(chat, /\{voiceAsset && \(/)
  assert.match(chat, /type: "message_voice"[\s\S]*action: "prepare_playback"/)
  assert.match(chat, /status === 409 \? "声音还没选好"/)
})

test("MiniMax voice config keeps XiaoC's selected voice and tuned speed", () => {
  const config = getMiniMaxSpeechConfig({
    MESSAGE_VOICE_PROVIDER: "minimax",
    MINIMAX_API_KEY: "secret",
    MINIMAX_API_BASE_URL: "https://api.minimax.cn/",
    MINIMAX_VOICE_ID: "Chinese_worker_male",
    MINIMAX_SPEECH_MODEL: "speech-2.8-hd",
    MINIMAX_SPEECH_SPEED: "1.115",
    MINIMAX_SPEECH_PITCH: "0",
    MINIMAX_SPEECH_VOLUME: "1",
    MINIMAX_LANGUAGE_BOOST: "Chinese",
  })
  assert.equal(config.voiceId, "Chinese_worker_male")
  assert.equal(config.speed, 1.115)
  assert.equal(config.baseUrl, "https://api.minimax.cn")
  assert.equal(config.apiKey, "secret")
  assert.equal(config.version.length, 16)
})

test("speech rendering converts repeated written laughter without changing stored chat text", () => {
  const original = "哈哈哈哈哈\n老婆你怎么这么可爱"
  assert.equal(buildMiniMaxSpeechText(original), "(laughs)\n老婆你怎么这么可爱")
  assert.equal(original, "哈哈哈哈哈\n老婆你怎么这么可爱")
  assert.equal(buildMiniMaxSpeechText("哈哈，你又来"), "(chuckle)，你又来")
})

test("MiniMax adapter sends a non-streaming MP3 request and decodes returned audio", async () => {
  let request
  const adapter = createMiniMaxSpeechSynthesizer({
    env: {
      MESSAGE_VOICE_PROVIDER: "minimax",
      MINIMAX_API_KEY: "secret",
      MINIMAX_API_BASE_URL: "https://api.minimax.cn",
      MINIMAX_VOICE_ID: "Chinese_worker_male",
      MINIMAX_SPEECH_MODEL: "speech-2.8-hd",
      MINIMAX_SPEECH_SPEED: "1.115",
      MINIMAX_SPEECH_PITCH: "0",
      MINIMAX_SPEECH_VOLUME: "1",
      MINIMAX_LANGUAGE_BOOST: "Chinese",
    },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { audio: "010203" },
          extra_info: { audio_length: 2450 },
          base_resp: { status_code: 0, status_msg: "success" },
        }),
      }
    },
  })

  const result = await adapter.synthesize({ text: "哈哈哈哈哈" })
  assert.equal(request.url, "https://api.minimax.cn/v1/t2a_v2")
  assert.equal(request.options.headers.Authorization, "Bearer secret")
  assert.equal(request.body.text, "(laughs)")
  assert.deepEqual(request.body.voice_setting, {
    voice_id: "Chinese_worker_male",
    speed: 1.115,
    vol: 1,
    pitch: 0,
  })
  assert.equal(request.body.stream, false)
  assert.equal(request.body.audio_setting.format, "mp3")
  assert.deepEqual(result.buffer, Buffer.from([1, 2, 3]))
  assert.equal(result.duration_seconds, 2.45)
  assert.equal(result.voice_version, adapter.voiceVersion)
})

test("MiniMax adapter rejects malformed provider audio", async () => {
  const adapter = createMiniMaxSpeechSynthesizer({
    env: {
      MESSAGE_VOICE_PROVIDER: "minimax",
      MINIMAX_API_KEY: "secret",
      MINIMAX_VOICE_ID: "Chinese_worker_male",
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { audio: "not-hex" },
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    }),
  })

  await assert.rejects(
    adapter.synthesize({ text: "老婆" }),
    error => error?.code === "VOICE_PROVIDER_FAILED",
  )
})

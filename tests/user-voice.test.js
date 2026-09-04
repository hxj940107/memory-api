import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  estimateGroqTranscriptionCost,
  normalizeUserVoiceAsset,
  transcribeAndStoreUserVoice,
} from "../lib/userVoice.js"

test("user voice metadata requires a complete private asset", () => {
  assert.equal(normalizeUserVoiceAsset({ status: "pending" }), null)
  const voice = normalizeUserVoiceAsset({
    id: "voice-1",
    status: "ready",
    storage_path: "user/chat/user-voice/audio.m4a",
    mime_type: "audio/mp4",
    size: 1234,
    duration_seconds: 7.5,
    provider: "groq",
    model: "whisper-large-v3",
    language: "zh",
    estimated_cost_usd: 0.00030833,
  })
  assert.equal(voice.provider, "groq")
  assert.equal(voice.duration_seconds, 7.5)
})

test("Groq transcription cost honors its ten-second minimum", () => {
  assert.equal(estimateGroqTranscriptionCost(1), estimateGroqTranscriptionCost(10))
  assert.equal(estimateGroqTranscriptionCost(3600), 0.111)
})

test("user voice is transcribed before being stored privately", async () => {
  const previousKey = process.env.GROQ_API_KEY
  const previousModel = process.env.GROQ_TRANSCRIBE_MODEL
  process.env.GROQ_API_KEY = "server-only-secret"
  process.env.GROQ_TRANSCRIBE_MODEL = "whisper-large-v3"
  let uploaded
  let request
  const supabase = {
    storage: {
      from(bucket) {
        assert.equal(bucket, "generated-files")
        return {
          async upload(path, buffer, options) {
            uploaded = { path, buffer, options }
            return { error: null }
          },
        }
      },
    },
  }
  try {
    const result = await transcribeAndStoreUserVoice({
      supabase,
      user_id: "user",
      conversation_id: "chat-one",
      audio_base64: Buffer.from("fake audio").toString("base64"),
      mime_type: "audio/mp4",
      duration_seconds: 12,
      fetchImpl: async (url, options) => {
        request = { url, options }
        return new Response(JSON.stringify({
          text: "小C，我回来了。",
          duration: 11.8,
          language: "zh",
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      },
    })
    assert.equal(result.transcript, "小C，我回来了。")
    assert.equal(result.voice.provider, "groq")
    assert.match(uploaded.path, /^user\/chat-one\/user-voice\/.+\.m4a$/)
    assert.equal(uploaded.options.contentType, "audio/mp4")
    assert.equal(request.options.headers.Authorization, "Bearer server-only-secret")
    assert.equal(request.options.body.get("language"), "zh")
  } finally {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = previousKey
    if (previousModel === undefined) delete process.env.GROQ_TRANSCRIBE_MODEL
    else process.env.GROQ_TRANSCRIBE_MODEL = previousModel
  }
})

test("an implausibly short recording cannot enter chat as a hallucinated transcript", async () => {
  const previousKey = process.env.GROQ_API_KEY
  process.env.GROQ_API_KEY = "server-only-secret"
  let uploadCalled = false
  const supabase = {
    storage: {
      from() {
        return {
          async upload() {
            uploadCalled = true
            return { error: null }
          },
        }
      },
    },
  }
  try {
    await assert.rejects(
      transcribeAndStoreUserVoice({
        supabase,
        user_id: "user",
        conversation_id: "chat-one",
        audio_base64: Buffer.from("nearly empty audio").toString("base64"),
        mime_type: "audio/mp4",
        duration_seconds: 8,
        fetchImpl: async () => new Response(JSON.stringify({
          text: "优优独播剧场——YoYo Television Series Exclusive",
          duration: 0.139,
          language: "zh",
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      }),
      error => error?.code === "USER_VOICE_EMPTY_TRANSCRIPT",
    )
    assert.equal(uploadCalled, false)
  } finally {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = previousKey
  }
})

test("a valid short Chinese transcript is not rejected by Whisper confidence metadata", async () => {
  const previousKey = process.env.GROQ_API_KEY
  process.env.GROQ_API_KEY = "server-only-secret"
  let uploadCalled = false
  const supabase = {
    storage: {
      from() {
        return {
          async upload() {
            uploadCalled = true
            return { error: null }
          },
        }
      },
    },
  }
  try {
    const result = await transcribeAndStoreUserVoice({
      supabase,
      user_id: "user",
      conversation_id: "chat-one",
      audio_base64: Buffer.from("valid short audio").toString("base64"),
      mime_type: "audio/mp4",
      duration_seconds: 3,
      fetchImpl: async () => new Response(JSON.stringify({
        text: "小C，你能听清吗？",
        duration: 3.1,
        language: "zh",
        segments: [{ no_speech_prob: 0.91 }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    })
    assert.equal(result.transcript, "小C，你能听清吗？")
    assert.equal(uploadCalled, true)
  } finally {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = previousKey
  }
})

test("mobile voice input switches modes before the large hold area records and sends", () => {
  const chat = fs.readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")
  assert.match(chat, /useAudioRecorder\(RecordingPresets\.LOW_QUALITY\)/)
  assert.match(chat, /const \[voiceInputMode, setVoiceInputMode\]/)
  assert.match(chat, /voiceInputMode \? "切换到文字输入" : "切换到语音输入"/)
  assert.match(chat, /styles\.voiceHoldButton/)
  assert.match(chat, /\{isRecordingVoice \? "松开 发送" : "按住 说话"\}/)
  const holdButton = chat.slice(chat.indexOf("styles.voiceHoldButton"), chat.indexOf("styles.inputBox", chat.indexOf("styles.voiceHoldButton")))
  assert.match(holdButton, /onStartShouldSetResponder=\{\(\) => true\}/)
  assert.match(holdButton, /onResponderTerminationRequest=\{\(\) => false\}/)
  assert.match(holdButton, /onResponderGrant=\{startUserVoiceRecording\}/)
  assert.match(holdButton, /onResponderRelease=\{stopUserVoiceRecording\}/)
  assert.match(chat, /audioRecorder\.getStatus\(\)/)
  assert.match(chat, /durationSeconds < 0\.6/)
  assert.match(chat, /XiaoCColors\.voiceHoldRecording/)
  assert.match(chat, /XiaoCColors\.voiceHoldRecordingText/)
  assert.match(chat, /type: "user_voice"[\s\S]*action: "transcribe"/)
  assert.match(chat, /userVoice: messageToSend\.metadata\?\.userVoice/)
  assert.match(chat, /!isUserVoice \|\| isVoiceTranscriptRevealed/)
  assert.match(chat, /options: \["取消", isRevealed \? "收起文字" : "转文字"\]/)
})

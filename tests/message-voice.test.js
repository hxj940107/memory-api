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
  estimateMiniMaxSpeechCostCny,
  getMiniMaxSpeechConfig,
  getMiniMaxSpeechPriceCnyPer10k,
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
    model: "speech-2.8-hd",
    usage_characters: 26,
    estimated_cost_cny: 0.0091,
    price_cny_per_10k: 3.5,
    presentation: "voice_reply",
  } })
  assert.equal(asset.id, "voice-1")
  assert.equal(asset.duration_seconds, 8.4)
  assert.equal(asset.usage_characters, 26)
  assert.equal(asset.estimated_cost_cny, 0.0091)
  assert.equal(asset.presentation, "voice_reply")
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

test("mobile voice UI uses a two-step reveal before generating audio", () => {
  const chat = fs.readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")
  assert.match(chat, /const \[expandedVoiceMessageId, setExpandedVoiceMessageId\]/)
  assert.match(chat, /onPress=\{\(\) => toggleMessageVoiceControl\(item\)\}/)
  assert.match(chat, /isVoiceReply \|\| expandedVoiceMessageId === item\.id/)
  assert.match(chat, /onPress=\{\(\) => playMessageVoice\(item\)\}/)
  const revealControl = chat.slice(
    chat.indexOf("const toggleMessageVoiceControl"),
    chat.indexOf("const playMessageVoice"),
  )
  assert.doesNotMatch(revealControl, /postJson|prepare_playback/)
  const messageMenu = chat.slice(
    chat.indexOf("{messageMenu && ("),
    chat.indexOf("{selectionModalVisible && ("),
  )
  assert.doesNotMatch(messageMenu, />听语音</)
  assert.match(chat, /type: "message_voice"[\s\S]*action: "prepare_playback"/)
  assert.match(chat, /status === 409 \? "声音还没选好"/)
})

test("a one-shot voice reply stays behind typing dots, then renders as voice with optional transcript", () => {
  const chat = fs.readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")
  assert.match(chat, /const \[voiceReplyRequested, setVoiceReplyRequested\]/)
  assert.match(chat, /voiceReplyRequested \? "取消小C语音回复" : "让小C语音回复"/)
  assert.match(chat, /小C将用语音回复/)
  assert.match(chat, /voiceReplyRequested,\s*\n/)
  assert.match(chat, /setVoiceReplyRequested\(false\)/)
  assert.match(
    chat,
    /messageToSend\.voiceReplyRequested[\s\S]*message_id: assistantCloudId[\s\S]*voice: voiceResult\.voice/,
  )
  const requestedReplyBlock = chat.slice(
    chat.indexOf("const shouldPrepareVoiceReply"),
    chat.indexOf("} catch (error) {", chat.indexOf("const shouldPrepareVoiceReply")),
  )
  assert.match(requestedReplyBlock, /loadAudio\(voiceResult\.url, assistantMessage\.id, false\)/)
  assert.match(requestedReplyBlock, /presentation: "voice_reply"/)
  assert.match(requestedReplyBlock, /setMessages\(\(prev\) => upsertCloudMessage\(prev, voiceMessage\)\)/)
  assert.match(requestedReplyBlock, /finally \{\s*setIsTyping\(false\)/)
  assert.match(chat, /voiceAsset\?\.presentation === "voice_reply"/)
  assert.match(chat, /isVoiceReply \|\| expandedVoiceMessageId === item\.id/)
  assert.match(chat, /options: \["取消", isRevealed \? "收起文字" : "转文字"\]/)
  assert.match(chat, /isVoiceReply && isVoiceTranscriptRevealed && !!item\.text/)
  assert.match(chat, /styles\.assistantVoiceTranscript/)
  assert.match(chat, /normalizeVoiceTranscriptText\(item\.text\)/)
  assert.match(chat, /\{isTyping && <TypingDots \/>\}/)
  assert.doesNotMatch(chat, /正在准备语音/)
  assert.match(chat, /const VOICE_WAVE_HEIGHTS = \[/)
  assert.match(chat, /height: 42/)
  assert.match(chat, /backgroundColor: XiaoCColors\.voiceBubble/)
  assert.match(chat, /150 \+ Math\.max\(0, displayedVoiceDuration\) \* 3/)
})

test("composer reserves the left wave for user voice and moves attachments outside right", () => {
  const chat = fs.readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8")
  const composer = chat.slice(
    chat.indexOf("<View style={styles.inputControls}>") ,
    chat.indexOf("</KeyboardAvoidingView>"),
  )
  assert.ok(composer.indexOf("styles.voiceInputButton") < composer.indexOf("styles.inputBox"))
  assert.ok(composer.indexOf("styles.inputBox") < composer.lastIndexOf("styles.attachButton"))
  assert.match(composer, /voiceInputWaveBar/)
  assert.doesNotMatch(composer, /voiceReplyToggle/)
  assert.match(chat, /options: \[[\s\S]*"选择图片"[\s\S]*"选择文件"[\s\S]*"让小C语音回复"/)
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
  assert.equal(config.timbreWeights, null)
  assert.equal(config.speed, 1.115)
  assert.equal(config.baseUrl, "https://api.minimax.cn")
  assert.equal(config.apiKey, "secret")
  assert.equal(config.version.length, 16)
})

test("MiniMax speech cost uses the official China character price", () => {
  assert.equal(getMiniMaxSpeechPriceCnyPer10k("speech-2.8-hd"), 3.5)
  assert.equal(getMiniMaxSpeechPriceCnyPer10k("speech-2.8-turbo"), 2)
  assert.equal(estimateMiniMaxSpeechCostCny({
    model: "speech-2.8-hd",
    usageCharacters: 100,
  }), 0.035)
  assert.equal(estimateMiniMaxSpeechCostCny({
    model: "unknown",
    usageCharacters: 100,
  }), null)
})

test("MiniMax voice config supports an optional two-voice blend", () => {
  const baseEnv = {
    MESSAGE_VOICE_PROVIDER: "minimax",
    MINIMAX_API_KEY: "secret",
    MINIMAX_VOICE_ID: "Chinese (Mandarin)_Stubborn_Friend",
    MINIMAX_SECONDARY_VOICE_ID: "Chinese (Mandarin)_Gentleman",
    MINIMAX_PRIMARY_VOICE_WEIGHT: "75",
    MINIMAX_SECONDARY_VOICE_WEIGHT: "25",
    MINIMAX_SPEECH_SPEED: "0.98",
  }
  const config = getMiniMaxSpeechConfig(baseEnv)
  assert.deepEqual(config.timbreWeights, [
    { voice_id: "Chinese (Mandarin)_Stubborn_Friend", weight: 75 },
    { voice_id: "Chinese (Mandarin)_Gentleman", weight: 25 },
  ])
  assert.equal(config.speed, 0.98)

  const differentBlend = getMiniMaxSpeechConfig({
    ...baseEnv,
    MINIMAX_PRIMARY_VOICE_WEIGHT: "70",
    MINIMAX_SECONDARY_VOICE_WEIGHT: "30",
  })
  assert.notEqual(config.version, differentBlend.version)
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
          extra_info: { audio_length: 2450, usage_characters: 26 },
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
  assert.equal(result.usage_characters, 26)
  assert.equal(result.estimated_cost_cny, 0.0091)
  assert.equal(result.price_cny_per_10k, 3.5)
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

test("MiniMax adapter sends configured timbre weights without changing playback settings", async () => {
  let requestBody
  const adapter = createMiniMaxSpeechSynthesizer({
    env: {
      MESSAGE_VOICE_PROVIDER: "minimax",
      MINIMAX_API_KEY: "secret",
      MINIMAX_VOICE_ID: "Chinese (Mandarin)_Stubborn_Friend",
      MINIMAX_SECONDARY_VOICE_ID: "Chinese (Mandarin)_Gentleman",
      MINIMAX_PRIMARY_VOICE_WEIGHT: "75",
      MINIMAX_SECONDARY_VOICE_WEIGHT: "25",
      MINIMAX_SPEECH_SPEED: "0.98",
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { audio: "010203" },
          extra_info: { audio_length: 1000 },
          base_resp: { status_code: 0, status_msg: "success" },
        }),
      }
    },
  })

  await adapter.synthesize({ text: "晚安" })
  assert.deepEqual(requestBody.voice_setting, {
    voice_id: "Chinese (Mandarin)_Stubborn_Friend",
    speed: 0.98,
    vol: 1,
    pitch: 0,
  })
  assert.deepEqual(requestBody.timbre_weights, [
    { voice_id: "Chinese (Mandarin)_Stubborn_Friend", weight: 75 },
    { voice_id: "Chinese (Mandarin)_Gentleman", weight: 25 },
  ])
})

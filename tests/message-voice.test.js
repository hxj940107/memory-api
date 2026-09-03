import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  buildMessageVoiceContentHash,
  buildMessageVoiceStoragePath,
  normalizeMessageVoiceAsset,
  prepareMessageVoicePlayback,
} from "../lib/messageVoice.js"

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

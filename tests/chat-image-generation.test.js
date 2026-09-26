import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  CHAT_IMAGE_TOOL,
  buildImageProviderRequest,
  buildMainChatImageToolOptions,
  generateChatImage,
  parseChatImageToolCall,
  persistGeneratedChatImage,
  resolveAuthorizedSourceImage,
} from "../lib/chatImageGeneration.js"
import { AI_ENDPOINTS, AI_MODELS, CHAT_IMAGE_POLICY } from "../lib/aiConfig.js"

const toolMessage = (args) => ({
  tool_calls: [{
    id: "tool-1",
    type: "function",
    function: { name: "create_chat_image", arguments: JSON.stringify(args) },
  }],
})

test("ordinary assistant replies do not request image generation", () => {
  assert.equal(parseChatImageToolCall({ content: "Just a normal reply." }), null)
  assert.equal(CHAT_IMAGE_TOOL.function.name, "create_chat_image")
})

test("Claude image tool decisions parse one bounded generation or edit request", () => {
  assert.deepEqual(parseChatImageToolCall(toolMessage({
    mode: "generate",
    instruction: "A small lighthouse on a foggy coast",
  })), {
    id: "tool-1",
    mode: "generate",
    instruction: "A small lighthouse on a foggy coast",
    sourceMessageId: null,
    raw: toolMessage({
      mode: "generate",
      instruction: "A small lighthouse on a foggy coast",
    }).tool_calls[0],
  })
})

test("image provider configuration is centralized and always requests one image", () => {
  const request = buildImageProviderRequest({
    instruction: "A small lighthouse on a foggy coast",
  })
  assert.equal(AI_ENDPOINTS.openRouterImages, "https://openrouter.ai/api/v1/images")
  assert.equal(AI_MODELS.imageGeneration, "openai/gpt-image-2.5-flare")
  assert.equal(request.model, AI_MODELS.imageGeneration)
  assert.equal(request.n, 1)
  assert.equal(request.quality, CHAT_IMAGE_POLICY.quality)
  assert.equal(request.aspect_ratio, CHAT_IMAGE_POLICY.aspectRatio)
  assert.equal("input_references" in request, false)

  const edit = buildImageProviderRequest({
    instruction: "Turn this into a watercolor",
    sourceImage: "data:image/png;base64,aGVsbG8=",
  })
  assert.equal(edit.input_references.length, 1)
})

test("successful provider output is decoded once and persisted without base64 metadata", async () => {
  let providerCalls = 0
  const generated = await generateChatImage({
    instruction: "A small lighthouse on a foggy coast",
    fetchImpl: async (url, options) => {
      providerCalls += 1
      assert.equal(url, AI_ENDPOINTS.openRouterImages)
      assert.equal(JSON.parse(options.body).n, 1)
      return {
        ok: true,
        async json() {
          return {
            data: [{ b64_json: Buffer.from("fictional image").toString("base64"), media_type: "image/png" }],
            usage: { total_tokens: 12, cost: 0.01 },
          }
        },
      }
    },
  })
  assert.equal(providerCalls, 1)

  const uploads = []
  const attachment = await persistGeneratedChatImage({
    supabase: {
      storage: { from: () => ({ upload: async (...args) => (uploads.push(args), { error: null }) }) },
    },
    userId: "user",
    conversationId: "fictional-conversation",
    generated,
  })
  assert.equal(attachment.type, "generated_image")
  assert.equal(attachment.mime_type, "image/png")
  assert.equal("b64_json" in attachment, false)
  assert.equal("url" in attachment, false)
  assert.equal(uploads.length, 1)
})

test("provider failures are not retried", async () => {
  let calls = 0
  await assert.rejects(generateChatImage({
    instruction: "A fictional landscape",
    fetchImpl: async () => {
      calls += 1
      return { ok: false, status: 502, json: async () => ({ error: { message: "failed" } }) }
    },
  }), /failed/)
  assert.equal(calls, 1)
})

function messageQuery(result) {
  return {
    select() { return this },
    eq() { return this },
    in() { return this },
    async maybeSingle() { return result },
  }
}

test("editing accepts only an authorized image from the same user and conversation", async () => {
  const image = await resolveAuthorizedSourceImage({
    supabase: {
      from: () => messageQuery({
        data: {
          id: "fictional-message",
          role: "user",
          metadata: { imageUrl: "data:image/png;base64,aGVsbG8=" },
        },
        error: null,
      }),
    },
    userId: "user",
    conversationId: "fictional-conversation",
    currentUserMessageId: "fictional-message",
  })
  assert.equal(image, "data:image/png;base64,aGVsbG8=")
})

test("invalid or inaccessible edit sources fail closed before provider use", async () => {
  await assert.rejects(resolveAuthorizedSourceImage({
    supabase: { from: () => messageQuery({ data: null, error: null }) },
    userId: "user",
    conversationId: "fictional-conversation",
    currentUserMessageId: "missing-message",
  }), error => error.code === "SOURCE_IMAGE_UNAUTHORIZED")

  await assert.rejects(resolveAuthorizedSourceImage({
    supabase: {
      from: () => messageQuery({
        data: { id: "message", role: "user", metadata: { imageUrl: "https://untrusted.example/image.png" } },
        error: null,
      }),
    },
    userId: "user",
    conversationId: "fictional-conversation",
    currentUserMessageId: "message",
  }), error => error.code === "SOURCE_IMAGE_UNAUTHORIZED")
})

test("persisted generated images can be authorized as later edit sources", async () => {
  const signedCalls = []
  const result = await resolveAuthorizedSourceImage({
    supabase: {
      from: () => messageQuery({
        data: {
          id: "assistant-message",
          role: "assistant",
          metadata: {
            attachments: [{
              type: "generated_image",
              storage_path: "user/fictional-conversation/image/xiaoc-image.png",
            }],
          },
        },
        error: null,
      }),
      storage: {
        from: () => ({
          async createSignedUrl(path, expiresIn) {
            signedCalls.push({ path, expiresIn })
            return { data: { signedUrl: "https://signed.example/image" }, error: null }
          },
        }),
      },
    },
    userId: "user",
    conversationId: "fictional-conversation",
    currentUserMessageId: "current-message",
    sourceMessageId: "assistant-message",
  })
  assert.equal(result, "https://signed.example/image")
  assert.equal(signedCalls.length, 1)
})

test("main chat tool definition is stable and keepalive does not receive it", () => {
  const first = buildMainChatImageToolOptions("conversation-1")
  const second = buildMainChatImageToolOptions("conversation-1")
  assert.deepEqual(first, second)

  const chat = fs.readFileSync(new URL("../api/chat.js", import.meta.url), "utf8")
  const keepaliveStart = chat.indexOf("req.body?.action === BP1_CACHE_KEEPALIVE_TASK_TYPE")
  const keepaliveEnd = chat.indexOf("const existingClientTurn", keepaliveStart)
  assert.doesNotMatch(chat.slice(keepaliveStart, keepaliveEnd), /buildMainChatImageToolOptions|generateChatImage/)
  assert.match(chat, /metadata: \{[\s\S]*attachments\.length \? \{ attachments \}/)
  assert.match(chat, /tool_choice: "none"/)
})

test("mobile renders persisted generated images through the existing chat image component", () => {
  const app = fs.readFileSync(new URL("../mobile/XiaoC/src/app/chat.tsx", import.meta.url), "utf8")
  const history = fs.readFileSync(new URL("../api/history.js", import.meta.url), "utf8")
  assert.match(app, /hydrateGeneratedImageAttachments/)
  assert.match(app, /attachment\.type === "generated_image"/)
  assert.match(app, /<ChatMessageImage/)
  assert.match(history, /metadata: item\.metadata \|\| \{\}/)
})

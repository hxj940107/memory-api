import test from "node:test"
import assert from "node:assert/strict"
import { authorizeChatImage, assertChatImageAuthorization } from "../lib/chatImageAuthorization.js"
import { generateChatImage, buildMainChatImageToolOptions } from "../lib/chatImageGeneration.js"

test("direct natural requests grant separated current-turn modes", () => {
  for (const text of ["帮我画一只虚构狐狸", "我想要一张你画的海报", "生成一张抽象图片", "Please draw a fictional bird"]) {
    assert.equal(authorizeChatImage(text)?.mode, "generate")
  }
  for (const text of ["把这张照片改成水彩", "请编辑这张图片", "Edit this photo"]) assert.equal(authorizeChatImage(text)?.mode, "edit")
})
test("uncertainty, negation, discussion, quotation and ambiguous consent fail closed", () => {
  for (const text of ["不要画一只狐狸", "如果画一只狐狸呢", "画画真有趣", "她说，画一只狐狸", "“画一只狐狸”是标题", "好啊", "共享相册很好用"]) assert.equal(authorizeChatImage(text), null)
})
test("provider hard gate rejects forged, missing, wrong-mode and real-album authority without paid request", async () => {
  const generate = authorizeChatImage("Draw a fictional landscape")
  const edit = authorizeChatImage("Edit this photo")
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error("unexpected provider call") }
  for (const args of [{}, { authorization: { mode: "generate" } }, { authorization: edit },
    { authorization: generate, sourceImage: "https://example.invalid/image" },
    { authorization: generate, sourceMode: "real_album_source" }]) {
    await assert.rejects(generateChatImage({ instruction: "fixture", fetchImpl, ...args }))
  }
  assert.equal(calls, 0)
  assert.equal(authorizeChatImage("画一张图片", "real_album_source"), null)
  assert.throws(() => assertChatImageAuthorization(generate, "edit"))
})
test("unauthorized text chat keeps album tools and no image tool; authorized tool is available", () => {
  assert.deepEqual(buildMainChatImageToolOptions("fixture").tools.map(t=>t.function.name), ["shared_album"])
  assert.equal(buildMainChatImageToolOptions("fixture", {}, authorizeChatImage("Draw a fictional bird")).tools[0].function.name, "create_chat_image")
})

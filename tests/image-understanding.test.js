import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  getImageCompressionProfile,
  isLikelyScreenshot,
} from "../mobile/XiaoC/src/lib/imageUploadProfile.ts"
import {
  buildImageDescriptionPrompt,
  buildImageUnderstandingContext,
  normalizeImageKinds,
} from "../lib/imageUnderstanding.js"

test("detects screenshots conservatively without a model call", () => {
  assert.equal(isLikelyScreenshot({
    fileName: "Screenshot_20260820.jpg",
    mimeType: "image/jpeg",
    width: 1170,
    height: 2532,
  }), true)
  assert.equal(isLikelyScreenshot({
    fileName: "IMG_1234.PNG",
    mimeType: "image/png",
    width: 1170,
    height: 2532,
  }), true)
  assert.equal(isLikelyScreenshot({
    fileName: "IMG_1234.jpg",
    mimeType: "image/jpeg",
    width: 1170,
    height: 2532,
  }), false)
})

test("uses screenshot-only compression profiles and preserves photo defaults", () => {
  const screenshot = {
    fileName: "Screenshot.png",
    mimeType: "image/png",
    width: 1170,
    height: 2532,
  }
  const photo = {
    fileName: "IMG_1234.jpg",
    mimeType: "image/jpeg",
    width: 3024,
    height: 4032,
  }

  assert.deepEqual(getImageCompressionProfile(screenshot, 1), {
    kind: "screenshot",
    maxLongSide: 1568,
    quality: 0.84,
  })
  assert.deepEqual(getImageCompressionProfile(screenshot, 3), {
    kind: "screenshot",
    maxLongSide: 1280,
    quality: 0.8,
  })
  assert.deepEqual(getImageCompressionProfile(photo, 1), {
    kind: "photo",
    maxLongSide: 1024,
    quality: 0.65,
  })
  assert.deepEqual(getImageCompressionProfile(photo, 3), {
    kind: "photo",
    maxLongSide: 768,
    quality: 0.58,
  })
})

test("normalizes missing client hints as unknown instead of inventing a type", () => {
  assert.deepEqual(normalizeImageKinds(["screenshot"], 3), [
    "screenshot",
    "unknown",
    "unknown",
  ])
})

test("Sonnet rules preserve UI hierarchy without changing ordinary photo behavior", () => {
  const prompt = buildImageUnderstandingContext(["screenshot", "photo"])

  assert.match(prompt, /作者头像不是正文配图/)
  assert.match(prompt, /评论区头像不是正文配图/)
  assert.match(prompt, /正文区域没有图片.*纯文字朋友圈/)
  assert.match(prompt, /聊天气泡正文和气泡内实际发送的图片/)
  assert.match(prompt, /普通生活照片仍按自然视觉内容理解/)
})

test("Haiku prompt covers the five visual description scenarios", () => {
  const prompt = buildImageDescriptionPrompt(["screenshot"])

  // Pure-text Moments screenshot with an author avatar.
  assert.match(prompt, /正文发布区域没有大图或图片网格时.*正文配图：无/)
  assert.match(prompt, /不得把头像误判成配图/)

  // Moments with one body image or a body image grid.
  assert.match(prompt, /正文配图：无\/1张\/多图及关键内容/)

  // WeChat or another chat screenshot.
  assert.match(prompt, /参与者：…；主要内容：…；实际图片：无\/有及关键内容/)
  assert.match(prompt, /头像、表情按钮、输入栏和 UI 图标不是聊天中实际发送的图片/)

  // Ordinary life photo.
  assert.match(prompt, /普通生活照片则自然描述主体/)
  assert.match(prompt, /总长度不超过180个中文字符/)
})

test("the screenshot classifier remains local and does not add a model request", () => {
  const source = fs.readFileSync(
    new URL("../mobile/XiaoC/src/lib/imageUploadProfile.ts", import.meta.url),
    "utf8",
  )

  assert.doesNotMatch(source, /fetch\s*\(|callLLM|openrouter|anthropic/i)
})

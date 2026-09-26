import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  isImageAttachment,
  normalizeGeneratedAttachments,
} from "../mobile/XiaoC/src/lib/generatedAttachments.ts"

const attachment = (mime_type, type = "generated_file") => ({
  id: `fictional-${mime_type}`,
  name: "fictional-asset.bin",
  mime_type,
  size: 1024,
  storage_path: "user/fictional-conversation/fictional-asset",
  type,
})

test("generated PNG attachments are classified as inline images by MIME", () => {
  assert.equal(isImageAttachment(attachment("image/png")), true)
})

test("generated JPEG and WebP attachments are classified as inline images", () => {
  assert.equal(isImageAttachment(attachment("image/jpeg")), true)
  assert.equal(isImageAttachment(attachment("image/jpg")), true)
  assert.equal(isImageAttachment(attachment("image/webp")), true)
})

test("ordinary generated attachments remain files", () => {
  assert.equal(isImageAttachment(attachment("text/plain")), false)
  assert.equal(isImageAttachment(attachment("application/pdf")), false)
})

test("history metadata preserves MIME for restored image classification", () => {
  const restored = normalizeGeneratedAttachments({
    attachments: [attachment("image/png")],
  })
  assert.equal(restored.length, 1)
  assert.equal(isImageAttachment(restored[0]), true)
})

test("chat wires inline render, history signing, preview, and long-press save", () => {
  const chat = fs.readFileSync(new URL("../mobile/XiaoC/src/app/chat.tsx", import.meta.url), "utf8")

  assert.match(chat, /isImageAttachment\(attachment\) &&\s*attachment\.display_url/)
  assert.match(chat, /hydrateGeneratedImageAttachments/)
  assert.match(chat, /setPreviewImageUri\(/)
  assert.match(chat, /<ImagePreviewModal/)
  assert.match(chat, /onLongPress=\{\(\) =>\s*saveGeneratedImage\(item, attachment\)/)
  assert.match(chat, /options: \["取消", "保存图片"\]/)
  assert.match(chat, /Sharing\.shareAsync/)
  assert.match(chat, /preserveAspectRatio/)
})

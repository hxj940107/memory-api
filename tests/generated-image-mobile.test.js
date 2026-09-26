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

test("SDK 54 media library dependency and iOS permission config are present", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../mobile/XiaoC/package.json", import.meta.url), "utf8"))
  const appJson = JSON.parse(fs.readFileSync(new URL("../mobile/XiaoC/app.json", import.meta.url), "utf8"))
  const mediaPlugin = appJson.expo.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "expo-media-library",
  )

  assert.equal(packageJson.dependencies["expo-media-library"], "~18.2.1")
  assert.ok(mediaPlugin)
  assert.match(mediaPlugin[1].savePhotosPermission, /保存到系统相册/)
  assert.deepEqual(mediaPlugin[1].granularPermissions, ["photo"])
})

test("chat wires inline render, history signing, preview, and long-press save", () => {
  const chat = fs.readFileSync(new URL("../mobile/XiaoC/src/app/chat.tsx", import.meta.url), "utf8")
  const preview = fs.readFileSync(new URL("../mobile/XiaoC/src/components/ImagePreviewModal.tsx", import.meta.url), "utf8")
  const album = fs.readFileSync(new URL("../mobile/XiaoC/src/app/album.tsx", import.meta.url), "utf8")

  assert.match(chat, /isImageAttachment\(attachment\) &&\s*attachment\.display_url/)
  assert.match(chat, /hydrateGeneratedImageAttachments/)
  assert.match(chat, /setPreviewImageUri\(/)
  assert.match(chat, /<ImagePreviewModal/)
  assert.match(chat, /<GeneratedImagePressable/)
  assert.match(chat, /delayLongPress=\{450\}/)
  assert.match(chat, /pressRetentionOffset=\{20\}/)
  assert.match(chat, /onLongPress=\{\(\) => \{\s*longPressHandledRef\.current = true;\s*onSave\(\)/)
  assert.match(chat, /if \(longPressHandledRef\.current\) \{[\s\S]*return;[\s\S]*onOpen\(\)/)
  assert.match(chat, /onSave=\{\(\) =>\s*openGeneratedImageActions\(item, attachment\)/)
  assert.match(chat, /options: \["取消", "保存至本地", "保存至共享相册"\]/)
  assert.match(chat, /MediaLibrary\.getPermissionsAsync\(true, \["photo"\]\)/)
  assert.match(chat, /MediaLibrary\.requestPermissionsAsync\(true, \["photo"\]\)/)
  assert.match(chat, /MediaLibrary\.saveToLibraryAsync\(downloaded\.uri\)/)
  assert.match(chat, /showFeedbackToast\("保存成功"\)/)
  assert.match(chat, /Alert\.alert\("需要照片权限"/)
  assert.match(chat, /stageSharedAlbumImport\(\{[\s\S]*successMessage: "已保存至共享相册"/)
  assert.match(album, /showFeedbackToast\(successMessage\)/)
  assert.match(chat, /preserveAspectRatio/)

  const localSaveStart = chat.indexOf("const saveGeneratedImageLocally")
  const sharedSaveStart = chat.indexOf("const saveGeneratedImageToSharedAlbum")
  assert.ok(localSaveStart > 0 && sharedSaveStart > localSaveStart)
  assert.doesNotMatch(chat.slice(localSaveStart, sharedSaveStart), /Sharing\.shareAsync/)

  assert.match(preview, /onLongPressImage\?:/)
  assert.match(preview, /Gesture\.LongPress\(\)/)
  assert.match(preview, /Gesture\.Race\(pinch, longPress, tap\)/)
  assert.match(preview, /\.enabled\(Boolean\(onLongPressImage\)\)/)
  assert.match(chat, /onLongPressImage=\{previewGeneratedImage/)
})

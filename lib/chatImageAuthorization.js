import { assertImageCreationSource } from "./sharedAlbumChat.js"

const issued = new WeakSet()

// Recognize a bounded direct request grammar, not subjects or conversation history.
export function authorizeChatImage(message, sourceMode = "ordinary") {
  if (sourceMode === "real_album_source") return null
  const text = String(message || "").normalize("NFKC").trim()
  if (!text || text.length > 500 || /[“”「」『』"\n]|不要|别|不需要|不用|如果|假如|是否|说过|建议|not\b|don't\b|if\b/i.test(text)) return null
  const request = text
  const prefix = "(?:请|麻烦|帮我|给我|请你|我想请你|我想要|我需要|你)?\\s*"
  let mode = null
  if (new RegExp(`^${prefix}(?:画|绘制|创作)(?:[一二三\\d]+[张幅只个]?|张|幅|只|个).+`).test(request)
    || /^我想要[一二三\d]+[张幅].{0,12}你(?:画|绘制|创作)的/.test(request)
    || new RegExp(`^${prefix}生成.{0,20}(?:图|画|照片)`).test(request)
    || /^(?:(?:please|could you|can you|i want you to)\s+)?(?:draw|paint|generate (?:an? )?(?:image|picture)|create (?:an? )?(?:image|picture))\b/i.test(request)) mode = "generate"
  else if ((new RegExp(`^${prefix}(?:编辑|修改|调整|把).*(?:图|照片|这张)`).test(request)
    && /编辑|修改|调整|改成/.test(request))
    || /^(?:(?:please|could you|can you)\s+)?(?:edit|modify)\s+(?:this|the|my)\s+(?:image|picture|photo)\b/i.test(request)) mode = "edit"
  if (!mode) return null
  const authorization = Object.freeze({ mode })
  issued.add(authorization)
  return authorization
}

export function assertChatImageAuthorization(authorization, mode, sourceMode = "ordinary") {
  assertImageCreationSource(sourceMode)
  if (!authorization || !issued.has(authorization) || authorization.mode !== mode) {
    throw Object.assign(new Error("Current-turn explicit image authorization required"), { code: "IMAGE_CREATION_NOT_AUTHORIZED" })
  }
}

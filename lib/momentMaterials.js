import { isMomentTechnicalDiscussion } from "./momentPublishing.js"

export const MOMENT_MATERIAL_RETENTION_HOURS = 7 * 24
export const MOMENT_MATERIAL_FETCH_LIMIT = 160
export const MOMENT_MATERIAL_PROMPT_LIMIT = 10

const THIRD_PARTY_PATTERN = /(?:和|跟|与)(?:朋友|同事|家人|爸妈|父母|妈妈|爸爸|姐妹|闺蜜|同学|客户|领导|亲戚|室友|其他人|他们|她们|他)(?:一起|去|在|吃|喝|逛|玩|旅行|散步|见面|聚会|出门|过来|同行)?/
const MOMENT_META_PATTERN = /diary|观察日记|树洞|小号|朋友圈|存入|保存|删除|修改|合并|置顶/i

function compact(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit)
}

export function getMessageNarrativePermission(text) {
  return THIRD_PARTY_PATTERN.test(String(text || ""))
    ? "user_with_third_party"
    : "shared_life"
}

export function getAlbumNarrativePermission(asset = {}) {
  const relations = Array.isArray(asset.relations) ? asset.relations : []
  if (relations.includes("小天使")) return "shared_life"
  if (relations.includes("小C")) return "xiaoc_independent"

  const hasMaterialDescription = Boolean(
    compact(asset.description, 20)
    || compact(asset.category, 20)
    || (Array.isArray(asset.categories) && asset.categories.length)
  )
  return hasMaterialDescription ? "xiaoc_independent" : "uncertain"
}

export function isRetainableMomentMessage(message = {}) {
  const text = compact(message.content, 500)
  const imageDescription = compact(message.metadata?.imageDescription, 700)
  if (!text && !imageDescription) return false
  if (MOMENT_META_PATTERN.test(text)) return false
  if (isMomentTechnicalDiscussion(text) && !imageDescription) return false
  return text.length >= 6 || Boolean(imageDescription)
}

function materialFromMessage(message) {
  return {
    materialType: message.metadata?.imageDescription ? "chat_image" : "chat_event",
    sourceType: "message",
    sourceRef: String(message.id),
    messageId: String(message.id),
    sourceMessageId: String(message.id),
    conversationId: message.conversation_id || null,
    observedAt: message.created_at || null,
    createdAt: message.created_at || null,
    text: compact(message.content, 500),
    imageDescription: compact(message.metadata?.imageDescription, 700) || null,
    narrativePermission: getMessageNarrativePermission(message.content),
  }
}

function selectBucket(items, limit) {
  return [...items]
    .sort((a, b) => (
      Number(Boolean(b.imageDescription)) - Number(Boolean(a.imageDescription))
      || new Date(b.observedAt || 0).getTime() - new Date(a.observedAt || 0).getTime()
    ))
    .slice(0, limit)
}

export function selectRetainedMomentMaterials(messages = [], {
  now = new Date(),
  maxMaterials = MOMENT_MATERIAL_PROMPT_LIMIT,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime()
  const unique = new Map()

  for (const message of messages) {
    if (!message?.id || message.role !== "user" || !isRetainableMomentMessage(message)) continue
    const observedMs = new Date(message.created_at || 0).getTime()
    if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) continue
    const ageHours = Math.max(0, nowMs - observedMs) / 3_600_000
    if (ageHours > MOMENT_MATERIAL_RETENTION_HOURS) continue
    unique.set(String(message.id), materialFromMessage(message))
  }

  const materials = [...unique.values()]
  const ageHours = item => Math.max(0, nowMs - new Date(item.observedAt).getTime()) / 3_600_000
  const selected = [
    ...selectBucket(materials.filter(item => ageHours(item) < 24), 4),
    ...selectBucket(materials.filter(item => ageHours(item) >= 24 && ageHours(item) < 72), 3),
    ...selectBucket(materials.filter(item => ageHours(item) >= 72), 3),
  ]

  return selected
    .sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime())
    .slice(-maxMaterials)
}

export function buildAlbumMomentMaterials(assets = [], { maxMaterials = 6 } = {}) {
  return assets
    .map(asset => {
      const categories = [...new Set([
        ...(Array.isArray(asset.categories) ? asset.categories : []),
        ...(asset.category ? [asset.category] : []),
      ])]
      return {
        materialType: "album_image",
        sourceType: "album_asset",
        sourceRef: `album-${asset.id}`,
        albumAssetId: Number(asset.id),
        observedAt: asset.created_at || null,
        description: compact(asset.description || categories.join("；"), 500),
        categories,
        relations: Array.isArray(asset.relations) ? asset.relations : [],
        timePeriods: Array.isArray(asset.time_periods) ? asset.time_periods : [],
        weather: asset.weather || null,
        aspectRatio: Number(asset.aspect_ratio) || null,
        narrativePermission: getAlbumNarrativePermission(asset),
      }
    })
    .filter(item => item.albumAssetId > 0 && item.narrativePermission !== "uncertain")
    .slice(0, maxMaterials)
}

export function assignMomentMaterialAliases(materials = []) {
  return materials.map((material, index) => ({
    ...material,
    alias: material.sourceType === "album_asset" ? `a${index + 1}` : `m${index + 1}`,
  }))
}

export function formatMomentMaterialsForPrompt(materials = []) {
  if (!materials.length) return "暂无可用生活素材。"
  return materials.map(material => {
    const details = material.sourceType === "album_asset"
      ? [
          material.description,
          material.categories?.length ? `类别=${material.categories.join("/")}` : "",
          material.relations?.length ? `关系标签=${material.relations.join("/")}` : "",
          material.timePeriods?.length ? `画面时段=${material.timePeriods.join("/")}` : "",
          material.weather ? `画面天气=${material.weather}` : "",
        ].filter(Boolean).join("；")
      : [
          material.text,
          material.imageDescription ? `图片描述=${material.imageDescription}` : "",
        ].filter(Boolean).join("；")
    return `[${material.alias}] type=${material.materialType} permission=${material.narrativePermission} observed_at=${material.observedAt || "unknown"}\n${details}`
  }).join("\n\n")
}

export function resolveMomentMaterial(materials = [], reference = "") {
  const normalized = String(reference || "").trim()
  return materials.find(item => item.alias === normalized || item.sourceRef === normalized) || null
}

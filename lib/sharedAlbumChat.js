import { albumPhotoAttachments, viewSharedAlbumPhotos } from "./sharedAlbumVision.js"
import { isMomentWritingRequest } from "./momentPublishing.js"

const fields = "id,description,category,categories,time_periods,weather,relations,aspect_ratio,last_used_at,created_at"
export function sharedAlbumQuery(client, owner) {
  if (!owner) throw new Error("ALBUM_OWNER_REQUIRED")
  return client.from("album_assets").select(fields).eq("user_id", owner)
    .eq("access_scope", "shared").eq("enabled", true).is("archived_at", null)
}
export async function readSharedAlbum(client, owner, { assetId = null, limit = 24 } = {}) {
  let query = sharedAlbumQuery(client, owner)
  if (assetId !== null) query = query.eq("id", assetId)
  const { data, error } = await query.order("last_used_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false }).limit(Math.min(200, limit))
  if (error) throw new Error("ALBUM_READ_FAILED")
  return data || []
}
export const SHARED_ALBUM_TOOL = { type: "function", function: {
  name: "shared_album", description: "Read authorized REAL shared photos metadata, then select an ID returned by this tool. This does not generate images or publish. browse reads metadata only. To actually see photos, browse with short keywords (e.g. 长滩岛 落日), then view up to 3 returned IDs. To send real photos into this chat use send with up to 3 observed asset_ids; it also supplies originals to your next reply. select is only for Moments publication. Original images are supplied to your next reply after view succeeds; never claim visual inspection before that. To publish, the user must explicitly request Moments publication.",
  parameters: { type: "object", additionalProperties: false, required: ["action"], properties: {
    action: { type: "string", enum: ["browse", "select", "view", "send"] },
    query: { type: "string", description: "Search keywords separated by spaces; omit conversational filler. Match descriptions/tags, e.g. 长滩岛 落日. Empty browses recent photos." },
    asset_ids: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 3, description: "For view/send: IDs returned by browse in this request." },
    asset_id: { type: "integer", description: "For select, an ID returned by browse in this request." },
  } },
} }
export function isRealAlbumRequest(text) {
  const value = String(text || "").normalize("NFKC").replace(/\s+/g, "")
  const photoLook = /(?:看|翻|找|发).{0,40}(?:拍的|拍过的|照片|相片)|(?:照片|相片).{0,30}(?:看|翻|找|发)/.test(value)
  const source = /相册|我们拍的照片|真实照片/.test(value)
  const operation = /(?:从|在|去|打开|查看|看看|浏览|翻|挑|选|使用|用|发).{0,40}(?:相册|我们拍的照片|真实照片)|(?:相册|我们拍的照片|真实照片).{0,40}(?:挑|选|看|浏览|使用|发|给我)/.test(value)
  const creation = /画|绘制|创作|生成|设计/.test(value)
  const sourceSelection = /(?:从|在|去).{0,20}(?:相册|我们拍的照片)|(?:挑|选|查看|浏览|打开).{0,20}(?:真实照片|相册)/.test(value)
  return (source && operation || photoLook) && (!creation || sourceSelection)
}
export function assertImageCreationSource(sourceMode) {
  if (sourceMode === "real_album_source") throw Object.assign(new Error("Real album resources cannot be replaced by generated images"), { code: "REAL_ALBUM_REQUEST_NOT_GENERATION" })
}
export function mayPublishAlbum(text) {
  return isMomentWritingRequest(text) && !/(?:不要|别|不必|先不|暂不).{0,8}(?:发|发布)|只.{0,4}(?:挑|选|看看)/.test(String(text))
}
export function albumReplyState({ result, selected, publishRequested }) {
  const viewed = result.ok && result.visual_access === "original_images_supplied"
  return { ...result,
    album_query_status: result.ok ? "succeeded" : "failed",
    visual_access: viewed ? "original_images_supplied" : result.ok ? "metadata_only" : "none",
    chat_image_display: result.ok && result.chat_photos_queued ? "attachment_queued" : "not_attached",
    photo_truth_contract: viewed ? "Original images follow this tool result in the current request. Describe only visible evidence; metadata is user-provided context. Never invent a generated substitute or claim publication." : "Only album metadata was read, not original pixels. Do not invent visible details or treat Memory as photographic evidence. No photo attachment is queued by browse/select. Use send to attach observed real photos; never substitute generated images.",
    publication_status: selected && result.ok && publishRequested ? "pending_async_decision" : "not_started",
    published: false,
    response_contract: viewed ? "Read the supplied original images and answer her request naturally. No Moments publication occurred. If chat_photos_queued is true, real photo attachments are queued with this reply. If image retrieval fails at the provider, report it honestly." : result.ok
      ? "The authorized album query succeeded. Do not say album access is unavailable. You only read metadata, not original pixels. Publication has NOT completed: pending_async_decision means a later Moments task will decide/validate/publish, which may fail or decline. Never confirm publication or equate an independent Moment with this tool's success."
      : "This album tool failed. Do not claim to have read photos or published. Report this attempt's failure, not a permanent lack of album capability.",
  }
}
export async function executeSharedAlbumTool({ client, owner, args, seen }) {
  if (args.action === "view" || args.action === "send") {
    const visionPhotos = await viewSharedAlbumPhotos({ client, owner, ids: args.asset_ids, seen })
    return { visionPhotos, ...(args.action === "send" ? { attachments: albumPhotoAttachments(visionPhotos) } : {}), result: { ok: true, source: "real_shared_album", visual_access: "original_images_supplied", viewed_asset_ids: visionPhotos.map(p => p.id), chat_photos_queued: args.action === "send", published: false } }
  }
  if (args.action === "browse") {
    const rows = await readSharedAlbum(client, owner, { limit: 200 })
    const query = String(args.query || "").trim().toLowerCase()
    const terms = query.normalize("NFKC").split(/[\s，,、]+/).filter(Boolean).slice(0, 8)
    const selected = rows.filter(row => {
      const text = JSON.stringify([row.description, row.categories, row.category, row.relations]).normalize("NFKC").toLowerCase()
      return terms.every(term => text.includes(term) || (term === "落日" && text.includes("日落")) || (term === "日落" && text.includes("落日")))
    }).slice(0, 24)
    selected.forEach(row => seen.set(Number(row.id), row))
    return { result: { ok: true, source: "real_shared_album", visual_access: "metadata_only", photos: selected } }
  }
  if (args.action !== "select" || !seen.has(args.asset_id)) throw new Error("ALBUM_ID_NOT_OBSERVED")
  const rows = await readSharedAlbum(client, owner, { assetId: args.asset_id, limit: 1 })
  if (!rows.length) throw new Error("ALBUM_NOT_AUTHORIZED")
  return { selected: rows[0], result: { ok: true, selected_asset_id: rows[0].id,
    source: "real_shared_album", published: false, visual_access: "metadata_only" } }
}

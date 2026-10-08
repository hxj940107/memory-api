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
    .order("created_at", { ascending: false }).limit(Math.min(24, limit))
  if (error) throw new Error("ALBUM_READ_FAILED")
  return data || []
}
export const SHARED_ALBUM_TOOL = { type: "function", function: {
  name: "shared_album", description: "Read authorized REAL shared photos metadata, then select an ID returned by this tool. This does not generate images or publish. No original images are viewed: do not claim visual inspection or invent composition details. To publish, the user must explicitly request Moments publication.",
  parameters: { type: "object", additionalProperties: false, required: ["action"], properties: {
    action: { type: "string", enum: ["browse", "select"] },
    query: { type: "string", description: "Optional literal metadata search; empty browses available photos." },
    asset_id: { type: "integer", description: "For select, an ID returned by browse in this request." },
  } },
} }
export function isRealAlbumRequest(text) {
  const value = String(text || "").normalize("NFKC").replace(/\s+/g, "")
  const source = /共享相册|我们的相册|我们拍的照片|真实照片|相册(?:里|中|内)/.test(value)
  const operation = /(?:从|在|去|打开|查看|看看|浏览|翻|挑|选|使用|用|发).{0,40}(?:相册|我们拍的照片|真实照片)|(?:相册|我们拍的照片|真实照片).{0,40}(?:挑|选|看|浏览|使用|发|给我)/.test(value)
  const creation = /画|绘制|创作|生成|设计/.test(value)
  const sourceSelection = /(?:从|在|去).{0,20}(?:相册|我们拍的照片)|(?:挑|选|查看|浏览|打开).{0,20}(?:真实照片|相册)/.test(value)
  return source && operation && (!creation || sourceSelection)
}
export function assertImageCreationSource(sourceMode) {
  if (sourceMode === "real_album_source") throw Object.assign(new Error("Real album resources cannot be replaced by generated images"), { code: "REAL_ALBUM_REQUEST_NOT_GENERATION" })
}
export function mayPublishAlbum(text) {
  return isMomentWritingRequest(text) && !/(?:不要|别|不必|先不|暂不).{0,8}(?:发|发布)|只.{0,4}(?:挑|选|看看)/.test(String(text))
}
export function albumReplyState({ result, selected, publishRequested }) {
  return { ...result,
    album_query_status: result.ok ? "succeeded" : "failed",
    visual_access: result.ok ? "metadata_only" : "none",
    chat_image_display: "unsupported_no_attachment",
    photo_truth_contract: "Only album metadata was read, not original pixels. Do not invent visible details or treat Memory as photographic evidence. This client cannot display real album photos in chat: explain that limit, never substitute a generated attachment.",
    publication_status: selected && result.ok && publishRequested ? "pending_async_decision" : "not_started",
    published: false,
    response_contract: result.ok
      ? "The authorized album query succeeded. Do not say album access is unavailable. You only read metadata, not original pixels. Publication has NOT completed: pending_async_decision means a later Moments task will decide/validate/publish, which may fail or decline. Never confirm publication or equate an independent Moment with this tool's success."
      : "This album tool failed. Do not claim to have read photos or published. Report this attempt's failure, not a permanent lack of album capability.",
  }
}
export async function executeSharedAlbumTool({ client, owner, args, seen }) {
  if (args.action === "browse") {
    const rows = await readSharedAlbum(client, owner)
    const query = String(args.query || "").trim().toLowerCase()
    const selected = rows.filter(row => !query || JSON.stringify([row.description, row.categories, row.category, row.relations]).toLowerCase().includes(query))
    selected.forEach(row => seen.set(Number(row.id), row))
    return { result: { ok: true, source: "real_shared_album", visual_access: "metadata_only", photos: selected } }
  }
  if (args.action !== "select" || !seen.has(args.asset_id)) throw new Error("ALBUM_ID_NOT_OBSERVED")
  const rows = await readSharedAlbum(client, owner, { assetId: args.asset_id, limit: 1 })
  if (!rows.length) throw new Error("ALBUM_NOT_AUTHORIZED")
  return { selected: rows[0], result: { ok: true, selected_asset_id: rows[0].id,
    source: "real_shared_album", published: false, visual_access: "metadata_only" } }
}

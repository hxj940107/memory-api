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
  return /共享相册|真实照片|我们拍的照片|相册.*(?:看|挑|选)|(?:看|挑|选).*相册/.test(String(text))
}
export function mayPublishAlbum(text) {
  return isMomentWritingRequest(text) && !/(?:不要|别|不必|先不|暂不).{0,8}(?:发|发布)|只.{0,4}(?:挑|选|看看)/.test(String(text))
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

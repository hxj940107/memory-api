import { readSharedAlbum } from "./sharedAlbumChat.js"

// Materials and images must come from the current server-owned candidate lists.
// Never derive an asset ID from an alias suffix (e.g. m10).
export async function resolveMomentImageIdentity({ reference, materials = [], images = [], owner, client }) {
  const value = typeof reference === "string" ? reference.trim() : ""
  if (!value) return null
  let image = images.find(item => item.id === value)
  if (!image) {
    const material = materials.find(item => item.alias === value)
    if (!material || material.sourceType !== "album_asset"
      || (material.user_id && material.user_id !== owner)
      || !Number.isSafeInteger(material.albumAssetId) || material.albumAssetId <= 0
      || material.sourceRef !== `album-${material.albumAssetId}`) return null
    image = images.find(item => item.id === material.sourceRef && item.albumAssetId === material.albumAssetId)
  }
  if (!image) return null
  if (image.albumAssetId) {
    if (image.id !== `album-${image.albumAssetId}`) return null
    const rows = await readSharedAlbum(client, owner, { assetId: image.albumAssetId, limit: 1 })
    if (!rows.some(row => Number(row.id) === image.albumAssetId)) return null
  } else if (value !== image.id || !image.file) return null
  return image.id
}

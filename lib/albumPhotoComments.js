export const albumCommentsEnabled = (env = process.env) => env.XIAOC_ALBUM_COMMENTS_ENABLED === 'true'
export const ALBUM_PHOTO_COMMENT_PROMPT = `【照片下的私密留言，与朋友圈发布独立判断】
你也可以在本批照片下面给她留一句话。逐张决定有没有自然想说的，可以只评论其中几张，也可以全部不评论；不需要给每张交作业。
这是只有你和她可见的照片留言，不是朋友圈正文，不需要为了留言发布朋友圈，也不因不发朋友圈就必须留言。
沿用原有人格，直接对她说话，写你自己的反应、偏好或一个值得聊的小细节；不要逐项解说画面，不套固定情话，不要求夸赞、吃醋或表达想念。不猜人物身份，不编造拍摄现场或共同在场的回忆。
每张最多一条，通常一两句、80字以内，最多120字。不同照片不要换皮重复。只有实际收到原图才能谈可见细节；上传时间仍不代表拍摄时间。
在同一个JSON对象中另加comments数组。没有留言时为空数组；有留言时，每项仅含本批照片asset_id（整数）和content（留言正文）。最多3项。comments和shouldPost分别决定，shouldPost=false时仍可有comments。不输出示例或内部编号。`
export function parseAlbumPhotoComments(value, assets) {
  if (!Array.isArray(value)) return []
  const allowed = new Set(assets.map(asset => Number(asset.id)))
  const seen = new Set()
  return value.slice(0,3).flatMap(item => {
    const text = typeof item?.content === 'string' ? item.content.trim() : ''
    if (!Number.isSafeInteger(item?.asset_id) || !allowed.has(item.asset_id) || seen.has(item.asset_id)
      || !text || [...text].length > 120 || /<\/?(?:thinking|analysis)>|"(?:shouldPost|asset_id)"\s*:/.test(text)) return []
    seen.add(item.asset_id)
    return [{asset_id:item.asset_id,content:text}]
  })
}
export async function persistAlbumPhotoComments(client, userId, batch, enabled) {
  if (!enabled || !batch.result?.comments?.length) return null
  const {data,error}=await client.rpc('apply_album_photo_comments',{p_user_id:userId,p_batch_id:batch.id})
  if(error) throw new Error('ALBUM_COMMENT_SAVE_FAILED')
  return data
}

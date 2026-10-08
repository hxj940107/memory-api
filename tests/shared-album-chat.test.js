import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { readSharedAlbum, executeSharedAlbumTool, isRealAlbumRequest, mayPublishAlbum } from "../lib/sharedAlbumChat.js"
import { buildMainChatImageToolOptions } from "../lib/chatImageGeneration.js"
const photos = [
  { id: 1, user_id: "fixture", access_scope: "shared", enabled: true, archived_at: null, description: "A fictional lake" },
  { id: 2, user_id: "other", access_scope: "shared", enabled: true, archived_at: null },
  { id: 3, user_id: "fixture", access_scope: "private", enabled: true, archived_at: null },
  { id: 4, user_id: "fixture", access_scope: "shared", enabled: false, archived_at: null },
  { id: 5, user_id: "fixture", access_scope: "shared", enabled: true, archived_at: "2026-01-01" },
]
function client() { return { from() { let rows = [...photos]; const q = {
  select() { return q }, eq(k,v) { rows=rows.filter(r=>r[k]===v); return q },
  is(k,v) { return q.eq(k,v) }, order() { return q }, limit(n) { rows=rows.slice(0,n); return q },
  then(resolve) { return Promise.resolve({ data: rows }).then(resolve) },
}; return q } } }
test("real authorized album only; private, disabled, archived and foreign assets hidden", async () => {
  assert.deepEqual((await readSharedAlbum(client(), "fixture")).map(r=>r.id), [1])
  assert.deepEqual(await readSharedAlbum(client(), "fixture", { assetId: 2 }), [])
  await assert.rejects(readSharedAlbum(null, null))
})
test("selection requires observed ID and rechecks permission", async () => {
  const seen=new Map(); const base={ client:client(), owner:"fixture", seen }
  await assert.rejects(executeSharedAlbumTool({ ...base, args:{ action:"select", asset_id:999 } }))
  const browse=await executeSharedAlbumTool({ ...base, args:{ action:"browse" } })
  assert.equal(browse.result.visual_access,"metadata_only")
  const selection=await executeSharedAlbumTool({ ...base, args:{ action:"select", asset_id:1 } })
  assert.equal(selection.selected.id,1); assert.equal(selection.result.published,false)
  photos[0].enabled=false
  await assert.rejects(executeSharedAlbumTool({ ...base, args:{ action:"select", asset_id:1 } }))
  photos[0].enabled=true
})
test("real-photo routing and publish intent are distinct", () => {
  for (const text of ["去共享相册看看", "从我们拍的照片里挑一张", "选一张真实照片发朋友圈"]) assert.equal(isRealAlbumRequest(text),true)
  assert.equal(isRealAlbumRequest("画一只虚构狐狸"),false)
  assert.equal(mayPublishAlbum("从共享相册挑一张"),false)
  assert.equal(mayPublishAlbum("选一张真实照片发朋友圈"),true)
  assert.equal(mayPublishAlbum("挑一张，先不要发朋友圈"),false)
  assert.deepEqual(buildMainChatImageToolOptions("fixture").tools.map(t=>t.function.name),["create_chat_image","shared_album"])
})
test("chat integration preserves compatibility and verifies authorization before publication", () => {
  const code=readFileSync("api/chat.js","utf8")
  assert.ok(code.includes('code: "REAL_ALBUM_REQUEST_NOT_GENERATION"'))
  assert.ok(code.includes('ALBUM_AUTHORIZATION_REVOKED'))
  assert.ok(code.includes('SELECTED_ALBUM_IMAGE_REJECTED'))
  assert.ok(code.includes('selectedChatAlbum && mayPublishAlbum(message)'))
  assert.ok(code.includes('isMomentImageCompatible('))
})

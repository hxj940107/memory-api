import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { readSharedAlbum, executeSharedAlbumTool, isRealAlbumRequest, mayPublishAlbum, albumReplyState, assertImageCreationSource } from "../lib/sharedAlbumChat.js"
import { generateChatImage } from "../lib/chatImageGeneration.js"
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
  assert.deepEqual(buildMainChatImageToolOptions("fixture").tools.map(t=>t.function.name),["shared_album"])
})
test("chat integration preserves compatibility and verifies authorization before publication", () => {
  const code=readFileSync("api/chat.js","utf8")
  assert.ok(code.includes('code: "REAL_ALBUM_REQUEST_NOT_GENERATION"'))
  assert.ok(code.includes('ALBUM_AUTHORIZATION_REVOKED'))
  assert.ok(code.includes('SELECTED_ALBUM_IMAGE_REJECTED'))
  assert.ok(code.includes('selectedChatAlbum && mayPublishAlbum(message)'))
  assert.ok(code.includes('isMomentImageCompatible('))
})

test("real album source survives every provider attempt, including failure and empty results", async () => {
  for (const text of ["从共享相册挑一张喜欢的照片", "从共享相册选照片发朋友圈", "查看共享相册中的真实照片", "使用共享相册照片"]) {
    assert.equal(isRealAlbumRequest(text), true)
    const mode = isRealAlbumRequest(text) ? "real_album_source" : "ordinary"
    let calls = 0
    for (let retry = 0; retry < 3; retry++) {
      await assert.rejects(generateChatImage({ instruction: "fixture", sourceMode: mode,
        sourceImage: retry === 1 ? "https://example.invalid/fixture" : null,
        fetchImpl: async () => { calls++; throw new Error("must not run") } }), { code: "REAL_ALBUM_REQUEST_NOT_GENERATION" })
    }
    assert.equal(calls, 0)
    assert.throws(() => assertImageCreationSource(mode))
  }
})

test("ordinary mentions and explicit artwork do not activate real source mode", () => {
  for (const text of ["共享相册挺好用", "今天整理了相册", "帮我画一张虚构海岛照片", "生成一个共享相册界面", "编辑我刚发的图片"]) {
    assert.equal(isRealAlbumRequest(text), false)
    assert.doesNotThrow(() => assertImageCreationSource("ordinary"))
  }
})

test("no fake album attachment when real photo display is unsupported; model options remain restricted", () => {
  const result = albumReplyState({ result: { ok: true, photos: [] }, publishRequested: false })
  assert.equal(result.chat_image_display, "unsupported_no_attachment")
  assert.equal(result.attachments, undefined)
  assert.match(result.photo_truth_contract, /not original pixels/)
  const code = readFileSync("api/chat.js", "utf8")
  assert.ok(code.includes('const requestSourceMode = isRealAlbumRequest(message)'))
  assert.ok(code.includes('mainChatOptions.tools.filter(tool => tool.function.name === "shared_album")'))
  assert.ok(code.includes('sourceMode: requestSourceMode'))
})

test("tool reply exposes query success separately from pending or absent publication", () => {
  const browse = albumReplyState({ result: { ok: true, photos: [] }, publishRequested: true })
  assert.equal(browse.album_query_status, "succeeded")
  assert.equal(browse.publication_status, "not_started")
  const selected = albumReplyState({ result: { ok: true, selected_asset_id: 1 }, selected: { id: 1 }, publishRequested: true })
  assert.equal(selected.publication_status, "pending_async_decision")
  assert.equal(selected.published, false)
  assert.match(selected.response_contract, /may fail or decline/)
  assert.equal(albumReplyState({ result: { ok: true }, selected: { id: 1 }, publishRequested: false }).publication_status, "not_started")
})

test("failure cannot carry visual or publication success; independent Moments are not tool evidence", () => {
  const failed = albumReplyState({ result: { ok: false, error: "fixture_failure", published: true }, publishRequested: true })
  assert.equal(failed.visual_access, "none")
  assert.equal(failed.published, false)
  assert.equal(failed.publication_status, "not_started")
  assert.match(failed.response_contract, /Do not claim/)
  const pending = albumReplyState({ result: { ok: true }, selected: { id: 1 }, publishRequested: true })
  assert.match(pending.response_contract, /independent Moment/)
})

test("explicit album request forces dispatch and tool results reach existing follow-up; one publish site", () => {
  const code = readFileSync("api/chat.js", "utf8")
  assert.ok(code.includes('mainChatOptions.tool_choice = { type: "function", function: { name: "shared_album" } }'))
  assert.ok(code.includes('tool_call_id: call.id, content: JSON.stringify(result)'))
  assert.ok(code.includes('albumMessages = [...albumMessages, rawMessage, ...results]'))
  assert.ok(code.includes('callLLM(albumMessages, selectedChatModel'))
  assert.equal((code.match(/maybeCreateMoment\(\{/g) || []).length, 2) // declaration + sole dispatch
})

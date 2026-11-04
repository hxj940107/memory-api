import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { albumCommentsEnabled, parseAlbumPhotoComments, persistAlbumPhotoComments } from '../lib/albumPhotoComments.js'
import { parseAlbumSocialDecision, processAlbumMomentUploads } from '../lib/albumMomentUpload.js'
const assets=[{id:59,description:'周末下午茶',storage_path:'user/photo.jpg'}]
const reply=JSON.stringify({shouldPost:false,reason:'不适合公开',comments:[{asset_id:59,content:'这张我看着就想坐下来歇会儿。'}]})
test('comment parsing is batch-scoped, optional, deduplicated and independent from posting',()=>{
 assert.equal(albumCommentsEnabled({}),false)
 assert.equal(albumCommentsEnabled({XIAOC_ALBUM_COMMENTS_ENABLED:'true'}),true)
 const parsed=parseAlbumSocialDecision(reply,assets,true)
 assert.equal(parsed.shouldPost,false);assert.equal(parsed.comments.length,1)
 assert.equal(parseAlbumSocialDecision(reply,assets,false).comments,undefined)
 const malformedPost=parseAlbumSocialDecision(JSON.stringify({...JSON.parse(reply),shouldPost:true,asset_id:999,text:'bad'}),assets,true)
 assert.equal(malformedPost.shouldPost,false);assert.equal(malformedPost.comments.length,1)
 assert.deepEqual(parseAlbumPhotoComments([{asset_id:999,content:'foreign'},{asset_id:59,content:'x'.repeat(121)}],assets),[])
 assert.equal(parseAlbumPhotoComments([{asset_id:59,content:'第一条'},{asset_id:59,content:'第二条'}],assets).length,1)
 assert.deepEqual(parseAlbumPhotoComments(undefined,assets),[])
})
function fixture({recover=false,commentFailure=false,allowPost=false}={}) {
 const calls=[];let saved
 const client={calls,from(table){let update;const q={select(){return q},eq(){return q},is(){return q},in(){return q},gt(){return q},gte(){return q},order(){return q},limit(){return q},update(v){update=v;calls.push(['update',v]);return q},single(){return q},then(resolve){
 if(update?.status==='evaluated')saved=update.result
 return Promise.resolve({data:update?{id:'batch'}:table==='album_moment_batches'?(recover?[{id:'batch',result:JSON.parse(reply)}]:[]):table==='album_assets'?assets:[]}).then(resolve)
 }};return q},async rpc(name,args){calls.push([name,args]);if(name.startsWith('claim_'))return {data:{id:'batch',asset_ids:[59],allow_post:allowPost}}
 if(name==='apply_album_photo_comments')return commentFailure?{error:{}}:{data:{inserted:1}}
 return {data:{status:'declined'}}},storage:{from(){return {async createSignedUrl(){return {data:{signedUrl:'https://fixture.invalid/photo'}}}}}}}
 return {client,get saved(){return saved}}
}
test('one image-aware call can leave a comment while posting is gated and Shadow remains off for publishing',async()=>{
 const f=fixture();let count=0
 const result=await processAlbumMomentUploads({client:f.client,userId:'user',persona:'PERSONA',env:{XIAOC_ALBUM_COMMENTS_ENABLED:'true'},generate:async messages=>{
 count++;assert.match(messages[0].content,/comments和shouldPost分别决定/)
 return JSON.stringify({...JSON.parse(reply),shouldPost:true,asset_id:59,text:'下午茶的颜色很好看。',audience_fit:'public_share'})
 }})
 assert.equal(count,1);assert.equal(result.comments.inserted,1)
 assert.equal(f.saved.shouldPost,false);assert.equal(f.saved.comments.length,1)
 assert.ok(f.client.calls.some(c=>c[0]==='claim_album_comment_batch'))
 assert.equal(f.client.calls.find(c=>c[0]==='finish_album_moment_batch')[1].p_live,false)
})
test('saved-response recovery reapplies idempotent comments before finalization without a model call',async()=>{
 const f=fixture({recover:true});let calls=0
 await processAlbumMomentUploads({client:f.client,userId:'user',env:{XIAOC_ALBUM_COMMENTS_ENABLED:'true'},generate:async()=>{calls++}})
 assert.equal(calls,0)
 assert.deepEqual(f.client.calls.filter(c=>!['update'].includes(c[0])).map(c=>c[0]),['apply_album_photo_comments','finish_album_moment_batch'])
})
test('comment persistence failure leaves evaluated response recoverable; disabling performs no write',async()=>{
 let calls=0;assert.equal(await persistAlbumPhotoComments({rpc:()=>{calls++}},'user',{result:{comments:[{}]}},false),null);assert.equal(calls,0)
 const f=fixture({commentFailure:true})
 const result=await processAlbumMomentUploads({client:f.client,userId:'user',env:{XIAOC_ALBUM_COMMENTS_ENABLED:'true'},generate:async()=>reply})
 assert.equal(result.failed,true);assert.ok(f.saved.comments.length)
 assert.equal(f.client.calls.some(c=>c[0]==='finish_album_moment_batch'),false)
})
test('SQL validates live ownership and bounds, UI shows comments separately from photo settings',()=>{
 const sql=fs.readFileSync('supabase_album_photo_comments.sql','utf8')
 for(const text of ['enable row level security','from public,anon,authenticated','unique(user_id,asset_id)',"b.status<>'evaluated'",'aid=any(b.asset_ids)',"access_scope='shared'",'on conflict(user_id,asset_id) do nothing','claim_album_comment_batch','allow_post:=false'])assert.ok(sql.includes(text),text)
 const app=fs.readFileSync('mobile/XiaoC/src/app/album.tsx','utf8')
 assert.match(app,/小C的留言/);assert.match(app,/setDetailAssetId\(asset.id\)/);assert.match(app,/action: "comments"/)
 const api=fs.readFileSync('api/memory.js','utf8');const route=api.slice(api.indexOf('req.query.action === "comments"'),api.indexOf('req.query.action === "comments"')+1500)
 assert.match(route,/eq\("user_id", user_id\)/);assert.match(route,/is\("archived_at", null\)/)
 assert.doesNotMatch(route,/callSmallLLM/)
})

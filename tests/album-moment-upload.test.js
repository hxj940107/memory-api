import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { albumMomentMode, parseAlbumMomentDecision, buildAlbumMomentMessages, processAlbumMomentUploads } from '../lib/albumMomentUpload.js'
const now=new Date('2026-11-04T06:00:00Z')
const assets=[{id:58,description:'牛排烤土豆',storage_path:'user/photo.jpg',categories:['美食']}]
const yes=JSON.stringify({shouldPost:true,asset_id:58,text:'烤土豆的胡椒香气，看着就很有胃口。',audience_fit:'public_share'})
function fake({recovery=false,empty=false,unauthorized=false,signFail=false,finalizeFail=false}={}) {
 const calls=[];let generated=0;let saved=null
 const batch={id:'batch-fixture',asset_ids:[58],mode:'shadow'}
 const client={calls,get saved(){return saved},get generated(){return generated},
 from(table){let update=null; const q={select(){return q},eq(){return q},is(){return q},in(){return q},gt(){return q},gte(){return q},order(){return q},limit(){return q},update(v){update=v;calls.push(['update',table,v]);return q},single(){return q},then(resolve){
   let data=table==='album_assets'?(unauthorized?[]:assets):table==='album_moment_batches'?(recovery?[{id:batch.id}]:[]):[]
   if(update){if(update.status==='evaluated')saved=update.result;data={id:batch.id}}
   return Promise.resolve({data}).then(resolve)
 }};return q},
 async rpc(name,args){calls.push(['rpc',name,args]);if(name==='claim_album_moment_batch')return {data:empty?null:batch};return finalizeFail?{error:{message:'unavailable'}}:{data:{status:args.p_live?'created':'shadow'}}},
 storage:{from(bucket){assert.equal(bucket,'album-images');return {async createSignedUrl(){calls.push(['sign']);return signFail?{error:{}}:{data:{signedUrl:'https://fixture.invalid/original'}}}}}},
 }
 return {client,generate:async messages=>{generated++;calls.push(['model',messages]);return yes}}
}
test('defaults to shadow; explicit live and kill switch are independent of chat settings',()=>{
 assert.equal(albumMomentMode({}),'shadow');assert.equal(albumMomentMode({XIAOC_ALBUM_MOMENT_MODE:'live'}),'live')
 assert.equal(albumMomentMode({XIAOC_ALBUM_MOMENT_MODE:'off'}),'off')
 assert.equal(albumMomentMode({XIAOC_ALBUM_MOMENT_MODE:'typo'}),'off')
})
test('no due work or disabled switch never invokes model',async()=>{
 for(const options of [{empty:true},{}]){const f=fake(options);const r=await processAlbumMomentUploads({...f,userId:'user',persona:'persona',now,env:options.empty?{}:{XIAOC_ALBUM_MOMENT_MODE:'off'}});assert.equal(r.model_calls,0);assert.equal(f.client.generated,0)}
})
test('claim happens before one image-aware call; shadow finishes without live publication',async()=>{
 const f=fake();const r=await processAlbumMomentUploads({...f,userId:'user',persona:'FULL_PERSONA',now,env:{}})
 assert.equal(r.status,'shadow');assert.equal(f.client.generated,1)
 assert.equal(f.client.calls[0][1],'claim_album_moment_batch')
 const prompt=f.client.calls.find(c=>c[0]==='model')[1]
 assert.ok(prompt[0].content.startsWith('FULL_PERSONA'));assert.ok(prompt[1].content.some(c=>c.type==='image_url'))
 assert.equal(f.client.saved.asset_id,58)
 assert.equal(f.client.calls.find(c=>c[1]==='finish_album_moment_batch')[2].p_live,false)
})
test('live explicitly allows finalization; evaluated recovery never calls model',async()=>{
 const f=fake();assert.equal((await processAlbumMomentUploads({...f,userId:'user',persona:'x',now,env:{XIAOC_ALBUM_MOMENT_MODE:'live'}})).status,'created')
 const g=fake({recovery:true});await processAlbumMomentUploads({...g,userId:'user',persona:'x',now,env:{}})
 assert.equal(g.client.generated,0);assert.equal(g.client.calls.some(c=>c[1]==='claim_album_moment_batch'),false)
})
test('revocation/sign failure blocks the paid call; malformed output is terminal, not retried',async()=>{
 for(const options of [{unauthorized:true},{signFail:true}]){const f=fake(options);const r=await processAlbumMomentUploads({...f,userId:'user',now,env:{}});assert.equal(r.failed,true);assert.equal(f.client.generated,0)}
 let calls=0;const f=fake();await processAlbumMomentUploads({...f,userId:'user',now,env:{},generate:async()=>{calls++;return 'invalid'}})
 assert.equal(calls,1);assert.ok(f.client.calls.some(c=>c[0]==='update'&&c[2].status==='unknown'))
})
test('persisted response remains recoverable on finalization failure, without overwriting evaluated state',async()=>{
 const f=fake({finalizeFail:true});const r=await processAlbumMomentUploads({...f,userId:'user',now,env:{}})
 assert.equal(r.failed,true);assert.equal(f.client.saved.shouldPost,true)
})
test('strict output rejects cross-batch assets, private publishing, invented dates and malformed decisions',()=>{
 assert.equal(parseAlbumMomentDecision('{"shouldPost":false,"reason":"没有分享动机"}',assets).shouldPost,false)
 for(const change of [{asset_id:999},{audience_fit:'private_only'},{text:'今天刚刚吃的晚饭'},{shouldPost:'true'},{text:'用户正在吃饭'}]){
 assert.throws(()=>parseAlbumMomentDecision(JSON.stringify({...JSON.parse(yes),...change}),assets))}
})
test('migration enforces durable future-only enqueue, batching, budget, owner scope and recoverable finalize',()=>{
 const sql=fs.readFileSync('supabase_album_moment_upload.sql','utf8')
 for(const required of ['after insert on public.album_assets','interval \'5 minutes\'','limit 3',"at time zone 'Asia/Shanghai'",'pg_advisory_xact_lock','interrupted_generation_no_retry',"status='processing'","b.status<>'evaluated'","b.mode='shadow'",'enable row level security','from public,anon,authenticated','to service_role','ALBUM_UPLOAD_ASSET_REVOKED','ALBUM_UPLOAD_DUPLICATE_CANDIDATE']) assert.ok(sql.includes(required),required)
 const api=fs.readFileSync('api/memory.js','utf8')
 assert.match(api,/albumMomentMode\(\) !== "live"/)
 assert.match(api,/requestPurpose: "album_upload_moment"/)
 assert.match(api,/source_type", "album_upload"\)\.eq\("source_ref", candidate.source_ref\)/)
})

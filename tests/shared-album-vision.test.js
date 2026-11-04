import test from 'node:test'
import assert from 'node:assert/strict'
import { viewSharedAlbumPhotos, buildAlbumVisionMessage } from '../lib/sharedAlbumVision.js'
import { isRealAlbumRequest, executeSharedAlbumTool, albumReplyState } from '../lib/sharedAlbumChat.js'
const assets = [
  ...Array.from({length:30}, (_,i)=>({id:i+10,user_id:'owner',access_scope:'shared',enabled:true,archived_at:null,description:'其他照片'})),
  {id:1,user_id:'owner',access_scope:'shared',enabled:true,archived_at:null,description:'长滩岛日落',storage_path:'owner/photo.jpg'},
  {id:2,user_id:'other',access_scope:'shared',enabled:true,archived_at:null,description:'长滩岛落日',storage_path:'other/photo.jpg'},
]
function client() {
  const signed=[]
  return {signed,from(){let rows=[...assets]; const q={
    select(){return q}, eq(k,v){rows=rows.filter(r=>r[k]===v);return q},is(k,v){return q.eq(k,v)},
    order(){return q},limit(n){rows=rows.slice(0,n);return q},
    maybeSingle:async()=>({data:rows[0]}),then(resolve){return Promise.resolve({data:rows}).then(resolve)},
  };return q},storage:{from(bucket){return {async createSignedUrl(path,ttl){signed.push({bucket,path,ttl});return {data:{signedUrl:'https://fixture.invalid/photo'}}}}}}}
}
test('natural photo requests route to real album, not image generation',()=>{
 for(const text of ['你看看上次在长滩岛拍的落日','去看相册','看看我们拍的照片']) assert.equal(isRealAlbumRequest(text),true)
 for(const text of ['画一张长滩岛落日照片','看看这段代码']) assert.equal(isRealAlbumRequest(text),false)
})
test('keyword search finds older matching photos, including sunset synonyms, without foreign assets',async()=>{
 const seen=new Map(); const c=client()
 const r=await executeSharedAlbumTool({client:c,owner:'owner',seen,args:{action:'browse',query:'长滩岛 落日'}})
 assert.deepEqual(r.result.photos.map(p=>p.id),[1]);assert.equal(c.signed.length,0)
 const viewed=await executeSharedAlbumTool({client:c,owner:'owner',seen,args:{action:'view',asset_ids:[1]}})
 assert.equal(viewed.visionPhotos.length,1)
 assert.equal(JSON.stringify(viewed.result).includes('https:'),false)
 const state=albumReplyState({result:viewed.result,publishRequested:false})
 assert.equal(state.visual_access,'original_images_supplied');assert.equal(state.published,false)
 assert.equal(buildAlbumVisionMessage(viewed.visionPhotos).content.filter(p=>p.type==='image_url').length,1)
 assert.deepEqual(c.signed,[{bucket:'album-images',path:'owner/photo.jpg',ttl:120}])
})
test('unobserved, over-limit, revoked and foreign IDs cannot yield original images',async()=>{
 const c=client();const seen=new Map([[1,{}],[2,{}],[3,{}],[4,{}]])
 for(const ids of [[99],[1,2,3,4],[2]]) await assert.rejects(viewSharedAlbumPhotos({client:c,owner:'owner',seen,ids}))
 assets.find(p=>p.id===1).enabled=false
 await assert.rejects(viewSharedAlbumPhotos({client:c,owner:'owner',seen,ids:[1]}))
 assets.find(p=>p.id===1).enabled=true
 assert.equal(c.signed.length,0)
})

test('chat tool loop delivers original pixels to the existing model and stops further tools', async()=>{
 const {readFileSync}=await import('node:fs');const vm=await import('node:vm')
 const source=readFileSync('api/chat.js','utf8')
 const loop=source.slice(source.indexOf('for (let step = 0; step < 3; step++)'),source.indexOf('const imageToolCall =',source.indexOf('for (let step = 0; step < 3; step++)')))
 const c=client();const requests=[]
 const browse={role:'assistant',tool_calls:[{id:'browse',function:{name:'shared_album',arguments:JSON.stringify({action:'browse',query:'长滩岛 落日'})}}]}
 const view={role:'assistant',tool_calls:[{id:'view',function:{name:'shared_album',arguments:JSON.stringify({action:'view',asset_ids:[1]})}}]}
 await vm.runInNewContext(`(async()=>{${loop}})()`,{
 llm:{raw:{choices:[{message:browse}]}},reply:'',selectedChatAlbum:null,albumSeen:new Map(),albumMessages:[],
 supabase:c,user_id:'owner',message:'看看长滩岛拍的落日',executeSharedAlbumTool,albumReplyState,mayPublishAlbum:()=>false,
 buildAlbumVisionMessage,selectedChatModel:'fixture',mainChatOptions:{},mainChatLlmCalls:[],
 callLLM:async(messages,model,options)=>{requests.push({messages,options});return requests.length===1?{raw:{choices:[{message:view}]}}:{reply:'照片里的落日'}},
 })
 assert.equal(requests.length,2)
 assert.ok(requests[1].messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url')))
 assert.equal(requests[1].options.tool_choice,'none')
})

test('send queues real references without URLs or publishing, view alone queues nothing', async()=>{
 const c=client();const seen=new Map([[1,{}]])
 const sent=await executeSharedAlbumTool({client:c,owner:'owner',seen,requestText:'发一张照片给我',args:{action:'send',asset_ids:[1]}})
 assert.equal(sent.attachments[0].type,'shared_album_image')
 assert.equal(sent.attachments[0].album_asset_id,1)
 assert.equal(sent.attachments[0].storage_path,'owner/photo.jpg')
 assert.equal(JSON.stringify(sent.attachments).includes('https:'),false)
 const state=albumReplyState({result:sent.result,publishRequested:false})
 assert.equal(state.chat_image_display,'attachment_queued');assert.equal(state.published,false)
 const viewed=await executeSharedAlbumTool({client:c,owner:'owner',seen,args:{action:'view',asset_ids:[1]}})
 assert.equal(viewed.attachments,undefined)
})

test('history re-sign uses recorded message owner and live album permission, never generated bucket',async()=>{
 const {signGeneratedAttachmentDownload}=await import('../lib/generatedFiles.js')
 const attachment={id:'album-1',album_asset_id:1,type:'shared_album_image',name:'photo.jpg',mime_type:'image/jpeg',size:0,storage_path:'owner/photo.jpg'}
 const filters=[];let allowed=true;let signs=0
 const db={from(table){const q={select(){return q},eq(k,v){filters.push([table,k,v]);return q},is(k,v){return q.eq(k,v)},async maybeSingle(){return {data:table==='messages'?{metadata:{attachments:[attachment]}}:allowed?{storage_path:'owner/photo.jpg'}:null}}};return q},storage:{from(bucket){assert.equal(bucket,'album-images');return {async createSignedUrl(path){signs++;assert.equal(path,'owner/photo.jpg');return {data:{signedUrl:'https://fixture.invalid/signed'}}}}}}}
 const args={supabase:db,user_id:'owner',conversation_id:'chat',message_id:'message',attachment_id:'album-1'}
 assert.equal((await signGeneratedAttachmentDownload(args)).url,'https://fixture.invalid/signed')
 assert.ok(filters.some(([t,k,v])=>t==='messages'&&k==='user_id'&&v==='owner'))
 assert.ok(filters.some(([t,k,v])=>t==='album_assets'&&k==='user_id'&&v==='owner'))
 assert.ok(filters.some(([t,k,v])=>t==='album_assets'&&k==='enabled'&&v===true))
 allowed=false
 await assert.rejects(signGeneratedAttachmentDownload(args),{code:'ATTACHMENT_NOT_FOUND'})
 assert.equal(signs,1)
})

test('send defaults to one even if the model supplies three IDs',async()=>{
 const c=client(); const seen=new Map([[1,{}],[2,{}],[99,{}]])
 const sent=await executeSharedAlbumTool({client:c,owner:'owner',seen,requestText:'挑张照片发给我',args:{action:'send',asset_ids:[1,2,99]}})
 assert.deepEqual(sent.attachments.map(a=>a.album_asset_id),[1])
 assert.deepEqual(sent.result.viewed_asset_ids,[1])
 assert.equal(c.signed.length,1)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { albumSendLimit } from '../lib/sharedAlbumIntent.js'
import { isRealAlbumRequest, executeSharedAlbumTool } from '../lib/sharedAlbumChat.js'
const discussion='跑通了！我刚刚在想，怎么让相册更有意思，目前只做了这一步，让你能看到、能发给我。你还有什么想法吗？可以再做点什么有意思的'
test('actual feature discussion neither forces album mode nor permits any tool access',async()=>{
 assert.equal(isRealAlbumRequest(discussion),false)
 assert.equal(albumSendLimit(discussion),0)
 for(const action of ['browse','view','send']) await assert.rejects(executeSharedAlbumTool({client:null,owner:'user',seen:new Map(),requestText:discussion,args:{action,asset_ids:[49,50,51]}}),/ALBUM_DISCUSSION_ONLY/)
})
test('current request controls delivery and quantity independently of viewing',()=>{
 for(const text of ['你看看上次在长滩岛拍的落日','只看看相册，不要发给我','相册现在能发照片了','你之前发给我的那张很好看','比如“发一张照片给我”']) assert.equal(albumSendLimit(text),0,text)
 for(const text of ['找一张长滩岛的落日，选一张你最喜欢的发给我','49是什么？你直接发给我','选张照片给我看看']) assert.equal(albumSendLimit(text),1,text)
 assert.equal(albumSendLimit('发两张长滩岛照片给我'),2)
 assert.equal(albumSendLimit('发几张照片给我'),3)
 assert.equal(albumSendLimit('选一张就行，不用三张，发给我'),1)
 assert.equal(isRealAlbumRequest('去相册看看长滩岛照片'),true)
})
test('send without current-turn request is blocked before database access',async()=>{
 await assert.rejects(executeSharedAlbumTool({client:null,owner:'user',seen:new Map(),args:{action:'send',asset_ids:[49]}}),/ALBUM_SEND_NOT_REQUESTED_THIS_TURN/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const sql = readFileSync('supabase_conversation_delete.sql','utf8')
test('conversation deletion is atomic, scoped and preserves Memory evidence', () => {
 assert.match(sql,/security definer/)
 assert.match(sql,/memory-event:/)
 assert.ok(sql.indexOf('CONVERSATION_HAS_MEMORY_EVIDENCE') < sql.indexOf('delete from public.memory_capture_events'))
 for(const table of ['memory_capture_events','messages','conversations'])
   assert.match(sql,new RegExp(`delete from public.${table} where user_id = p_user_id and conversation_id = p_conversation_id`))
 assert.doesNotMatch(sql,/delete from public.memory_(?:items|provenance|operations)/)
 assert.match(sql,/from public, anon, authenticated/)
})

test('delete endpoint uses scoped transaction and surfaces protected-source conflict', async () => {
 const vm = await import('node:vm')
 const source = readFileSync('api/conversation-title.js','utf8')
   .replace(/^import .*;\n/gm,'')
   .replace(/const supabase = createClient\([\s\S]*?\);/,'')
   .replace('export default async function handler','async function handler')
 for (const error of [null,{message:'CONVERSATION_HAS_MEMORY_EVIDENCE'},{message:'database error'}]) {
  const calls=[];let status=200;let body
  const context={supabase:{rpc:async(name,args)=>{calls.push({name,args});return {data:{ok:true},error}}},requireRequestIdentity:async()=>true}
  const handler=vm.runInNewContext(source+';handler',context)
  await handler({body:{user_id:'fixture',conversation_id:'temporary',action:'delete'}},{status:n=>{status=n;return {json:x=>{body=x}}},json:x=>{body=x}})
  assert.equal(calls.length,1)
  assert.equal(calls[0].name,'xiaoc_delete_conversation')
  assert.equal(calls[0].args.p_user_id,'fixture')
  assert.equal(calls[0].args.p_conversation_id,'temporary')
  assert.equal(status,error?error.message.includes('HAS_MEMORY')?409:500:200)
  assert.equal(body.ok,!error?true:undefined)
 }
})

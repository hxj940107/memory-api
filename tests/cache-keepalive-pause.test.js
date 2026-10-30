import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isBp1CacheKeepaliveEnabled, BP1_CACHE_KEEPALIVE_TASK_TYPE } from '../lib/cacheKeepalive.js'

const chat = readFileSync('api/chat.js','utf8')
const memory = readFileSync('api/memory.js','utf8')
const disabled = () => false
const noIO = new Proxy({}, { get(){throw new Error('disabled path must not perform I/O')} })

test('synthetic keepalive defaults OFF and requires explicit true to resume',()=>{
  for (const value of [undefined,'false','0','TRUE','']) assert.equal(isBp1CacheKeepaliveEnabled({XIAOC_BP1_CACHE_KEEPALIVE_ENABLED:value}),false)
  assert.equal(isBp1CacheKeepaliveEnabled({XIAOC_BP1_CACHE_KEEPALIVE_ENABLED:'true'}),true)
})
test('disabled enqueue does not read/write tasks',async()=>{
  const body=chat.slice(chat.indexOf('async function enqueueBp1CacheKeepalive('),chat.indexOf('// Save Message',chat.indexOf('async function enqueueBp1CacheKeepalive(')))
  const run=vm.runInNewContext(`${body}\nenqueueBp1CacheKeepalive`,{isBp1CacheKeepaliveEnabled:disabled,supabase:noIO})
  assert.equal(await run({user_id:'user',conversation_id:'c',user_message_id:'m'}),null)
})
test('existing queued keepalive exits before activity read, internal HTTP or model call',async()=>{
  const body=memory.slice(memory.indexOf('async function executeProactiveTask('),memory.indexOf('async function checkPendingProactiveTasks('))
  const run=vm.runInNewContext(`${body}\nexecuteProactiveTask`,{
    BP1_CACHE_KEEPALIVE_TASK_TYPE,WEATHER_SHADOW_TASK_TYPE:'weather',PROACTIVE_ATTENTION_WAKEUP_TASK_TYPE:'attention',
    isBp1CacheKeepaliveEnabled:disabled,supabase:noIO,fetch:()=>{throw new Error('HTTP must not run')},
  })
  const result=await run({type:BP1_CACHE_KEEPALIVE_TASK_TYPE})
  assert.equal(result.skipped,true);assert.equal(result.reason,'bp1_cache_keepalive_disabled')
})
test('direct keepalive endpoint remains authenticated, then no-ops before snapshot/model',async()=>{
  const start=chat.indexOf('    if (req.body?.action === BP1_CACHE_KEEPALIVE_TASK_TYPE)')
  const end=chat.indexOf('    const existingClientTurn',start)
  const run=vm.runInNewContext(`(async function(req,res){${chat.slice(start,end)}})`,{
    BP1_CACHE_KEEPALIVE_TASK_TYPE,isBp1CacheKeepaliveEnabled:disabled,
    readCoreMemorySnapshot:()=>{throw new Error('snapshot must not run')},callLLM:()=>{throw new Error('model must not run')},
  })
  for (const actor of ['cron','user']) {
    let code,body
    const res={status(n){code=n;return res},json(value){body=value;return value}}
    await run({body:{action:BP1_CACHE_KEEPALIVE_TASK_TYPE},identity:{actorType:actor}},res)
    assert.equal(code,actor==='cron'?200:401)
    if(actor==='cron') assert.equal(body.reason,'bp1_cache_keepalive_disabled')
  }
})
test('normal cache builder, TTL, model configuration and request builder are byte-identical to HEAD',()=>{
  for(const file of ['lib/promptCaching.js','lib/claudeRequest.js','lib/aiConfig.js','lib/coreMemorySnapshot.js']) {
    assert.equal(readFileSync(file,'utf8'),execFileSync('git',['show',`HEAD:${file}`],{encoding:'utf8'}))
  }
  // Strip only the three synthetic-keepalive additions, then compare entire chat.
  const stripped=chat.replace('  isBp1CacheKeepaliveEnabled,\n','')
    .replace('  if (!isBp1CacheKeepaliveEnabled()) return null\n','')
    .replace('      if (!isBp1CacheKeepaliveEnabled()) {\n        return res.status(200).json({ success: true, skipped: true, reason: "bp1_cache_keepalive_disabled" })\n      }\n','')
  assert.equal(stripped,execFileSync('git',['show','HEAD:api/chat.js'],{encoding:'utf8'}))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { buildInactivityApproachPolicy, loadInactivityActivityContext } from '../lib/inactivityApproach.js'
import { parseInactivityGeneration, validateInactivityGeneration, canUseInactivitySoftFallback } from '../lib/inactivityGeneration.js'
import { getInactivitySilenceState } from '../lib/inactivityReachOut.js'

const now = Date.parse('2026-10-30T05:00:00Z')
const owner = '11111111-1111-4111-8111-111111111111'
const env = { XIAOC_ACTIVITY_UPLOAD_ENABLED: 'true', XIAOC_PRIVATE_AUTH_USER_UUID: owner }
const signal = (minutes, app = 'douyin') => ({ app, kind: 'opened', occurred_at: new Date(now - minutes * 60000).toISOString() })
function database(rows, error = null) {
  const calls = []
  return { calls, from(table) {
    calls.push(['table', table]); const q = {}
    for (const method of ['select','eq','gte','lte','order','limit']) q[method] = (...args) => { calls.push([method,...args]); return q }
    q.abortSignal = async () => ({ data: rows, error })
    return q
  } }
}
test('proactive signal is private-scoped, fresh, bounded and independently switchable', async () => {
  const db = database([signal(5), signal(45,'taobao')])
  const result = await loadInactivityActivityContext(db, 'user', { now, env: { ...env, XIAOC_ACTIVITY_CHAT_CONTEXT_ENABLED: 'false' } })
  assert.match(result, /抖音/); assert.doesNotMatch(result, /淘宝/)
  assert.match(result, /不能据此断定/)
  assert.ok(db.calls.some(c => c[0] === 'eq' && c[1] === 'owner_uuid' && c[2] === owner))
  for (const [id, options] of [['another-owner',env], ['user',{}], ['user',{ ...env, XIAOC_ACTIVITY_PROACTIVE_CONTEXT_ENABLED:'false' }]]) {
    const blocked = database([signal(5)])
    assert.equal(await loadInactivityActivityContext(blocked,id,{now,env:options}),'')
    assert.equal(blocked.calls.length,0)
  }
})
test('stale, repeated, absent or failed signal reads do not invent material', async () => {
  for (const db of [database([]),database([signal(45)]),database(null,{code:'unavailable'})]) {
    assert.equal(await loadInactivityActivityContext(db,'user',{now,env}),'')
  }
  const recentMessages = [{ role:'assistant',content:'抖音',created_at:new Date(now-60000).toISOString() }]
  assert.equal(await loadInactivityActivityContext(database([signal(5)]),'user',{now,env,recentMessages}),'')
})

// Run actual generator assembly; the model response is synthetic, not a live-model eval.
async function generate({ ceiling = false, activity = '', quiet = false, expressionOnly = false } = {}) {
  const source = readFileSync('api/memory.js','utf8')
  const body = source.slice(source.indexOf('async function generateInactivityReachOutMessage('), source.indexOf('function parseAutonomousTreeholeDrafts('))
  let request, calls = 0, reads = 0
  const run = vm.runInNewContext(`${body}\ngenerateInactivityReachOutMessage`, {
    fetchPinnedMemoryText:async()=>'', isProactiveQuietHours:()=>quiet,
    getMomentLocalTime:()=>({date:'2026-10-30',hour:13,minute:0}),
    getInactivityTimeContext:()=>({label:'白天',guidance:'自然靠近',period:'afternoon'}),
    getInactivityAttemptIndex:()=>1, getInactivitySilenceState:()=>({ceiling_contact_required:ceiling,silence_duration_minutes:720,prior_decline_count:2,reconsideration_count:2}),
    getCurrentInactivityReachOutMode:async()=> 'frequent',
    loadInactivityActivityContext:async()=>{reads++;return activity},supabase:{},
    formatTimedInactivityMessages:()=> '00:58 过去的哄睡对话',trimText:s=>s||'',
    systemPrompt:'FIXTURE_PERSONA',MOMENT_TIMEZONE:'Asia/Shanghai',buildInactivityApproachPolicy,
    callSmallLLM:async(messages,options)=>{calls++;request={messages,options};return JSON.stringify({...(expressionOnly ? {} : {should_send:true}),contact_motivation:'想找她撒娇',topic_state:'completed',temporal_fit:true,self_continuity:true,should_reference_topic:false,message:'想你了，分我一点陪伴好不好。'})},
    parseInactivityGeneration,validateInactivityGeneration,canUseInactivitySoftFallback,
    cleanProactiveMessage:s=>s,validateProactiveHistoricalClaims:()=>({valid:true}),
    isBadProactiveMessage:()=>false,isTimeInappropriateReachOut:()=>false,isTemporallyUnsupportedReachOut:()=>false,
  })
  const result = await run({expressionOnly,user_id:'user',task:{payload:{}},recentContext:{messages:[{role:'user',content:'过去的哄睡'}],recentProactiveMessages:[]}})
  return { result, request, calls, reads }
}
test('completed bedtime topic can yield a relationship-only message in the same single model call', async()=>{
  const f = await generate()
  assert.equal(f.calls,1);assert.equal(f.result.skipped,undefined)
  assert.match(f.result.content,/想你了/)
  assert.match(f.request.messages[0].content,/没有新话题.*不是充分依据/)
  assert.match(f.request.messages[0].content,/她现在仍在睡觉/)
  assert.equal(f.request.options.max_tokens,220)
  assert.equal(f.result.diagnostics.reach_out_mode,'frequent')
})
test('final opportunity and optional activity reach the generator, not a separate model trigger',async()=>{
  const f=await generate({ceiling:true,activity:'FIXTURE_ACTIVITY'})
  assert.equal(f.calls,1);assert.match(f.request.messages[1].content,/FIXTURE_ACTIVITY/)
  assert.match(f.request.messages[0].content,/should_send=true/)
  assert.equal(f.result.diagnostics.ceiling_contact_required,true)
  assert.equal(f.result.diagnostics.activity_context_available,true)
})
test('quiet hours still prevent generation and signal reads',async()=>{
  const f=await generate({quiet:true})
  assert.equal(f.calls,0);assert.equal(f.reads,0);assert.equal(f.result.skipped,true)
})

test('last-slot expression uses existing prompt, omits send decision and still generates once', async()=>{
  const f=await generate({ceiling:true,expressionOnly:true})
  assert.equal(f.calls,1)
  assert.match(f.request.messages[0].content,/只决定此刻怎样自然表达/)
  assert.match(f.request.messages[0].content,/FIXTURE_PERSONA/)
  assert.equal(f.result.skipped,undefined)
  assert.equal(f.result.diagnostics.expression_only,true)
  assert.equal(f.result.diagnostics.should_send,true)
})

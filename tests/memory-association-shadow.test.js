import test from 'node:test'
import assert from 'node:assert/strict'
import {associationShadow,generateAssociationCues,parseAssociationCues,cosine} from '../lib/memoryAssociationShadow.js'
const identity={providerId:'test',modelId:'test',version:'1',preprocessorVersion:'v1',dimension:2}
const memory={id:'m1',user_id:'owner',canonical_content:'private memory body',content_hash:'a'.repeat(64),origin_system:'xiaoc_native',category:'meaningful_experience',lifecycle_status:'active',provenance_status:'verified_user',authority_tier:'native_verified',retrieval_tier:null}
const quote='这是可以逐字核验的真实原话'
function fixture({stale=false,pinned=false,deleted=false,error=false}={}) {
 const rows={memory_association_cues:[{memory_id:'m1',content_hash:stale?'b'.repeat(64):memory.content_hash,embedding_identity:identity,cues:[{cue:'相似处境',source_id:'s1',quote,embedding:[1,0]}]}],memory_items:[{...memory,...(deleted?{lifecycle_status:'deleted'}:{})}],memory_provenance:[{id:'s1',memory_id:'m1',source_message_id:'u1',evidence_text:quote}],messages:[{id:'u1',role:'user',content:quote}],memory_pins:pinned?[{memory_id:'m1'}]:[]}
 return {from(table){const q={};for(const method of ['select','eq','in','limit','abortSignal'])q[method]=()=>q;q.then=(resolve,reject)=>Promise.resolve({data:rows[table],error:error?{}:null}).then(resolve,reject);return q},rpc(){return {abortSignal:()=>Promise.resolve({data:[],error:null})}}}
}
test('default off performs no I/O or paid generation',async()=>{
 const client={from(){throw Error('unexpected I/O')}}
 assert.deepEqual(await associationShadow({client}),{enabled:false,injected:false})
 assert.equal((await generateAssociationCues({client,env:{}})).reason,'flag_off')
})
test('cue evidence must be exact and belong to the chosen source',()=>{
 assert.equal(parseAssociationCues(JSON.stringify({cues:[{cue:'具体处境',source_id:'s',quote}]}),[{id:'s',evidence_text:quote}]).length,1)
 for(const item of [{cue:'处境',source_id:'wrong',quote},{cue:'处境',source_id:'s',quote:'不存在的原话也不允许'}])assert.throws(()=>parseAssociationCues(JSON.stringify({cues:[item]}),[{id:'s',evidence_text:quote}]))
 assert.equal(cosine([1,0],[1,0]),1);assert.equal(cosine([NaN],[1]),0)
})
test('shadow finds at most one candidate without returning private text or injecting it',async()=>{
 const result=await associationShadow({client:fixture(),userId:'owner',queryEmbedding:[1,0],identity,env:{XIAOC_MEMORY_ASSOCIATION_SHADOW_ENABLED:'true'}})
 assert.equal(result.injected,false);assert.equal(result.candidates.length,1)
 assert.equal(JSON.stringify(result).includes(memory.canonical_content),false)
})
test('stale revisions, PIN and deleted sources are excluded; DB failures degrade',async()=>{
 for(const options of [{stale:true},{pinned:true},{deleted:true}]){
 const r=await associationShadow({client:fixture(options),userId:'owner',queryEmbedding:[1,0],identity,env:{XIAOC_MEMORY_ASSOCIATION_SHADOW_ENABLED:'true'}})
 assert.deepEqual(r.candidates,[])
 }
 const r=await associationShadow({client:fixture({error:true}),userId:'owner',queryEmbedding:[1,0],identity,env:{XIAOC_MEMORY_ASSOCIATION_SHADOW_ENABLED:'true'}})
 assert.equal(r.failed,true);assert.equal(r.injected,false)
})

test('maintenance claim prevents repeated paid calls and validates exact evidence before embedding',async()=>{
 let claimed=false,calls=0,embeds=0,saved
 const client={from(table){let operation='read',payload;const q={};for(const method of ['select','eq','in','limit','single'])q[method]=()=>q
 q.insert=p=>{operation='insert';payload=p;return q};q.update=p=>{operation='update';payload=p;return q}
 q.then=(resolve,reject)=>{
 let result={data:[],error:null}
 if(table==='memory_items')result.data=memory
 if(table==='memory_provenance')result.data=[{id:'s',source_message_id:'u',source_role:'user',evidence_text:quote}]
 if(table==='messages')result.data=[{id:'u',role:'user',content:quote}]
 if(table==='memory_association_cues'&&operation==='insert'){result=claimed?{error:{code:'23505'}}:{data:{memory_id:'m1'}};claimed=true}
 if(table==='memory_association_cues'&&operation==='update'){saved=payload;result.data=[]}
 return Promise.resolve(result).then(resolve,reject)
 };return q}}
 const args={client,userId:'owner',memoryId:'m1',env:{XIAOC_MEMORY_ASSOCIATION_BUILD_ENABLED:'true'},provider:{...identity,embed:async()=>{embeds++;return [[1,0]]}},generate:async()=>{calls++;return JSON.stringify({cues:[{cue:'具体处境',source_id:'s',quote}]})}}
 assert.equal((await generateAssociationCues(args)).cue_count,1)
 assert.equal(saved.status,'ready');assert.equal(saved.cues[0].quote,quote)
 assert.equal((await generateAssociationCues(args)).reason,'already_attempted')
 assert.equal(calls,1);assert.equal(embeds,1)
})

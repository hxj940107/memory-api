import { evaluateCandidateEligibility, resolveMemoryCandidates } from './xiaocMemoryEligibility.js'
import { evaluateContextCandidates } from './contextEligibility.js'
import { XiaoCMemoryDbRetrievalRepository } from './xiaocMemoryDbRepository.js'

export const ASSOCIATION_POLICY = 'association-shadow-v1'
export const ASSOCIATION_PROMPT = `从提供的单次真实经历和原文证据提取0到2条联想检索线索。只输出JSON {"cues":[{"cue":"具体处境、互动关系或独特细节，最多100字","source_id":"证据ID","quote":"证据中逐字存在的原文，8到160字"}]}。线索不是新的事实；不得推断心理类型、动机、未来结果或不存在的共同经历。泛泛情绪、纯偏好、缺少具体经历时返回空数组。不要生成回复台词。`
const checked = ({data,error}) => { if(error) throw new Error('ASSOCIATION_DB_FAILED'); return data }
export function parseAssociationCues(raw, sources) {
  const value=JSON.parse(String(raw).trim().replace(/^```json\s*/i,'').replace(/```$/,''))
  if(!Array.isArray(value.cues)||value.cues.length>2) throw new Error('ASSOCIATION_OUTPUT_INVALID')
  return value.cues.map(item=>{
    const source=sources.find(s=>s.id===item.source_id)
    if(!source||typeof item.cue!=='string'||!item.cue.trim()||item.cue.length>100
      ||typeof item.quote!=='string'||item.quote.length<8||item.quote.length>160||!source.evidence_text.includes(item.quote)) throw new Error('ASSOCIATION_EVIDENCE_INVALID')
    return {cue:item.cue.trim(),source_id:source.id,quote:item.quote}
  })
}
export function cosine(a,b) {
  if(!Array.isArray(a)||!Array.isArray(b)||!a.length||a.length!==b.length||![...a,...b].every(Number.isFinite)) return 0
  const norm=Math.sqrt(a.reduce((s,x)=>s+x*x,0)*b.reduce((s,x)=>s+x*x,0))
  return norm ? a.reduce((s,x,i)=>s+x*b[i],0)/norm : 0
}
export async function generateAssociationCues({client,userId,memoryId,generate,provider,env=process.env}) {
  if(env.XIAOC_MEMORY_ASSOCIATION_BUILD_ENABLED!=='true') return {skipped:true,reason:'flag_off'}
  const memory=checked(await client.from('memory_items').select('*').eq('user_id',userId).eq('id',memoryId).single())
  if(memory.origin_system!=='xiaoc_native'||!['meaningful_experience','relationship_memory'].includes(memory.category)
    ||!evaluateCandidateEligibility(memory,{userId}).eligible) throw new Error('ASSOCIATION_SOURCE_INELIGIBLE')
  const pins=checked(await client.from('memory_pins').select('memory_id').eq('user_id',userId).eq('memory_id',memoryId).eq('pin_status','active'))
  if(pins?.length) throw new Error('ASSOCIATION_PIN_EXCLUDED')
  const sources=checked(await client.from('memory_provenance').select('id,evidence_text,source_message_id,source_role').eq('user_id',userId).eq('memory_id',memoryId).eq('source_kind','message').limit(8))||[]
  if(!sources.length) throw new Error('ASSOCIATION_NO_EVIDENCE')
  // Check stored quotations against current, owner-scoped source messages before spending.
  const messages=checked(await client.from('messages').select('id,role,content').eq('user_id',userId).in('id',sources.map(s=>s.source_message_id)))||[]
  const verified=sources.filter(s=>messages.some(m=>m.id===s.source_message_id&&m.role==='user'&&typeof m.content==='string'&&m.content.includes(s.evidence_text)))
  if(!verified.length) throw new Error('ASSOCIATION_EVIDENCE_UNAVAILABLE')
  if(memory.canonical_content.length>6000 || JSON.stringify(verified).length>14000) throw new Error('ASSOCIATION_INPUT_TOO_LARGE')
  const claim=await client.from('memory_association_cues').insert({user_id:userId,memory_id:memoryId,content_hash:memory.content_hash,status:'processing',policy_version:ASSOCIATION_POLICY}).select('memory_id').single()
  if(claim.error?.code==='23505') return {skipped:true,reason:'already_attempted'}
  checked(claim)
  try {
    const raw=await generate([{role:'system',content:ASSOCIATION_PROMPT},{role:'user',content:JSON.stringify({memory:memory.canonical_content,sources:verified.map(s=>({id:s.id,evidence_text:s.evidence_text}))})}])
    const cues=parseAssociationCues(raw,verified)
    const vectors=cues.length?await provider.embed(cues.map(c=>c.cue)):[]
    if(vectors.length!==cues.length||vectors.some(v=>v.length!==provider.dimension||!v.every(Number.isFinite))) throw new Error('ASSOCIATION_VECTOR_INVALID')
    checked(await client.from('memory_association_cues').update({status:'ready',cues:cues.map((c,i)=>({...c,embedding:vectors[i]})),embedding_identity:{providerId:provider.providerId,modelId:provider.modelId,version:provider.version,preprocessorVersion:provider.preprocessorVersion,dimension:provider.dimension}}).eq('user_id',userId).eq('memory_id',memoryId).eq('content_hash',memory.content_hash).eq('status','processing'))
    return {memory_id:memoryId,cue_count:cues.length,model_calls:1}
  } catch {
    await client.from('memory_association_cues').update({status:'failed'}).eq('user_id',userId).eq('memory_id',memoryId).eq('content_hash',memory.content_hash).eq('status','processing')
    return {memory_id:memoryId,failed:true,model_calls:1}
  }
}

export async function associationShadow({client,userId,queryEmbedding,identity,excludedMemoryIds=[],normalIds=[],context={},retrievalTime=new Date().toISOString(),env=process.env}) {
  if(env.XIAOC_MEMORY_ASSOCIATION_SHADOW_ENABLED!=='true'||!queryEmbedding) return {enabled:false,injected:false}
  try {
    const signal=AbortSignal.timeout(800)
    const rows=checked(await client.from('memory_association_cues').select('memory_id,content_hash,cues,embedding_identity').eq('user_id',userId).eq('status','ready').limit(20).abortSignal(signal))||[]
    if(!rows.length) return {enabled:true,candidates:[],injected:false}
    const memories=checked(await client.from('memory_items').select('*').eq('user_id',userId).in('id',rows.map(r=>r.memory_id)).abortSignal(signal))||[]
    const sources=checked(await client.from('memory_provenance').select('id,memory_id,evidence_text,source_message_id').eq('user_id',userId).in('memory_id',rows.map(r=>r.memory_id)).abortSignal(signal))||[]
    const messageIds=[...new Set(sources.map(s=>s.source_message_id).filter(Boolean))]
    const messages=messageIds.length ? checked(await client.from('messages').select('id,role,content').eq('user_id',userId).in('id',messageIds).abortSignal(signal))||[] : []
    const pins=checked(await client.from('memory_pins').select('memory_id').eq('user_id',userId).eq('pin_status','active').abortSignal(signal))||[]
    const excluded=new Set([...excludedMemoryIds,...pins.map(p=>p.memory_id)].map(String))
    const pool=[]
    for(const row of rows) {
      const memory=memories.find(m=>m.id===row.memory_id&&m.content_hash===row.content_hash)
      if(!memory||excluded.has(String(memory.id))||memory.origin_system!=='xiaoc_native'||!['meaningful_experience','relationship_memory'].includes(memory.category)||!evaluateCandidateEligibility(memory,{userId,retrievalTime}).eligible) continue
      if(!Object.keys(identity).every(k=>row.embedding_identity?.[k]===identity[k])) continue
      for(const cue of row.cues||[]) {
        if(!sources.some(s=>s.id===cue.source_id&&s.memory_id===memory.id&&s.evidence_text.includes(cue.quote)&&messages.some(m=>m.id===s.source_message_id&&m.role==='user'&&typeof m.content==='string'&&m.content.includes(s.evidence_text)))) continue
        const score=cosine(queryEmbedding,cue.embedding)
        if(score>=0.72) pool.push({...memory,associationScore:score})
      }
    }
    const unique=[...new Map(pool.sort((a,b)=>b.associationScore-a.associationScore).map(m=>[m.id,m])).values()]
    if(!unique.length) return {enabled:true,candidates:[],injected:false}
    const repository=new XiaoCMemoryDbRetrievalRepository({rpc:(...args)=>client.rpc(...args).abortSignal(signal)},{retrievalTime})
    const relations=await repository.listRelations({userId,memoryIds:unique.map(m=>m.id)})
    const resolved=resolveMemoryCandidates({candidates:unique,relations,context:{userId,retrievalTime,mode:'normal_current'}})
    const eligibleIds=new Set(resolved.eligible_candidates?.map(m=>m.id || m.memory_id)||[])
    const candidates=unique.filter(m=>eligibleIds.has(m.id)).map(m=>({memoryId:m.id,candidateId:`assoc-${m.id}`,content:m.canonical_content,semanticRelevance:m.associationScore,source:'association_shadow'}))
    const gateway=evaluateContextCandidates(candidates,context,{maxChars:600,minimumRelevance:null})
    return {enabled:true,injected:false,candidates:gateway.injected.slice(0,1).map(c=>({memory_id:c.memoryId,already_retrieved:normalIds.includes(c.memoryId)})),scanned:rows.length}
  } catch { return {enabled:true,injected:false,failed:true,error_code:'ASSOCIATION_SHADOW_UNAVAILABLE'} }
}

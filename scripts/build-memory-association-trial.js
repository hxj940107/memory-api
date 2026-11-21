// Explicit, single-ID maintenance runner; never scans or automatically retries.
import { createClient } from '@supabase/supabase-js'
import { generateAssociationCues } from '../lib/memoryAssociationShadow.js'
import { createXiaoCMemoryEmbeddingProvider } from '../lib/xiaocMemoryEmbedding.js'
import { AI_ENDPOINTS, AI_MODELS, APP_USER } from '../lib/aiConfig.js'
import { buildClaudeRequest } from '../lib/claudeRequest.js'
import { normalizeAssistantOutput } from '../lib/assistantOutput.js'

if(process.argv.length!==4 || process.argv[2]!=='--apply' || !/^[0-9a-f-]{36}$/i.test(process.argv[3])) {
  console.error('Usage: node --env-file=.env.local scripts/build-memory-association-trial.js --apply <reviewed-memory-uuid>')
  process.exitCode=1
} else {
  if(new URL(process.env.SUPABASE_URL).hostname!=='cncpymfqefyabiclnqzg.supabase.co') throw new Error('PRIVATE_PROJECT_MISMATCH')
  const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
  const result=await generateAssociationCues({client,userId:APP_USER.defaultUserId,memoryId:process.argv[3],
    provider:createXiaoCMemoryEmbeddingProvider({env:process.env}),env:{...process.env,XIAOC_MEMORY_ASSOCIATION_BUILD_ENABLED:'true'},
    generate:async messages=>{
      const response=await fetch(AI_ENDPOINTS.openRouterChatCompletions,{method:'POST',signal:AbortSignal.timeout(60000),
        headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json'},
        body:JSON.stringify(buildClaudeRequest({model:AI_MODELS.memoryJudge,messages,max_tokens:500,temperature:0,response_format:{type:'json_object'}}))})
      const payload=await response.json()
      if(!response.ok) throw new Error('ASSOCIATION_MODEL_FAILED')
      console.log(JSON.stringify({task:'memory_association_index',model:AI_MODELS.memoryJudge,cost:payload.usage?.cost??null}))
      return normalizeAssistantOutput(payload.choices?.[0]?.message).trim()
    }})
  console.log(JSON.stringify(result))
  if(result.failed) process.exitCode=1
}

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { buildMomentCommentPrompt } from '../lib/momentCommentPrompt.js'
test('both comment paths preserve the full persona with contextual public expression rules, no examples',()=>{
 const persona='PERSONA_FIXTURE_UNABRIDGED'
 for(const reply of [true,false]) {
  const prompt=buildMomentCommentPrompt(persona,{reply})
  assert.ok(prompt.startsWith(persona))
  assert.match(prompt,/公开可见/)
  assert.match(prompt,/不编造画面/)
  assert.match(prompt,/亲昵、幽默、关心或直白感情可以自然出现/)
  assert.doesNotMatch(prompt,/好的例子|不好的例子|不要主动输出|6 到 28/)
 }
 const source=fs.readFileSync('api/memory.js','utf8')
 assert.ok(source.includes('content: buildMomentCommentPrompt(systemPrompt, { reply: true })'))
 assert.ok(source.includes('content: buildMomentCommentPrompt(systemPrompt),'))
})
test('postprocessing no longer strips laughter, warmth or emoji but rejects system perspective',()=>{
 const source=fs.readFileSync('api/memory.js','utf8')
 const helpers=source.slice(source.indexOf('function cleanMomentReply('),source.indexOf('async function createXiaoCReplyForMomentComment('))
 const {clean,bad}=vm.runInNewContext(`${helpers}\n({clean:cleanMomentReply,bad:isBadMomentReplyTone})`,{trimText:(v,n)=>v.slice(0,n)})
 for(const text of ['哈哈，我喜欢这张😂','看着就开心。','你分析得还挺认真。']) {
  assert.equal(clean(text),text)
  assert.equal(bad(text),false)
 }
 assert.equal(bad('作为评论区回复，我认为'),true)
})

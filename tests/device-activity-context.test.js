import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadRecentDeviceActivity, formatDeviceActivityContext, DEVICE_ACTIVITY_CONTEXT_POLICY as policy } from '../lib/deviceActivityContext.js'

const now = Date.parse('2026-10-27T11:30:00Z')
const owner = '11111111-1111-4111-8111-111111111111'
const env = { XIAOC_ACTIVITY_UPLOAD_ENABLED: 'true' }
const row = (app = 'douyin', minutes = 5, kind = 'opened') => ({ app, kind, occurred_at: new Date(now - minutes * 60000).toISOString() })
function fixture(result) {
  const calls = []
  const client = { from(table) {
    calls.push(['from', table])
    const query = {}
    for (const method of ['select', 'eq', 'gte', 'lte', 'order', 'limit']) {
      query[method] = (...args) => { calls.push([method, ...args]); return query }
    }
    query.abortSignal = async signal => { assert.ok(signal instanceof AbortSignal); return result }
    return query
  } }
  return { client, calls }
}

test('read is bounded, owner scoped, event-time filtered, abortable and metadata only', async () => {
  const { client, calls } = fixture({ data: [row()] })
  assert.equal((await loadRecentDeviceActivity(client, owner, { env, now })).length, 1)
  assert.deepEqual(calls.find(c => c[0] === 'eq'), ['eq', 'owner_uuid', owner])
  assert.deepEqual(calls.find(c => c[0] === 'select'), ['select', 'app,kind,occurred_at'])
  assert.deepEqual(calls.find(c => c[0] === 'limit'), ['limit', 24])
  assert.ok(calls.some(c => c[0] === 'gte'))
  assert.ok(calls.some(c => c[0] === 'lte'))
})
test('disabled, absent identity and rollback switch perform no database work', async () => {
  for (const [id, config] of [[null, env], ['user', env], [owner, {}], [owner, { ...env, XIAOC_ACTIVITY_CHAT_CONTEXT_ENABLED: 'false' }]]) {
    const { client, calls } = fixture({ data: [row()] })
    assert.deepEqual(await loadRecentDeviceActivity(client, id, { env: config, now }), [])
    assert.equal(calls.length, 0)
  }
})
test('missing schema, aborted request and database exceptions degrade to ordinary chat', async () => {
  assert.deepEqual(await loadRecentDeviceActivity(fixture({ error: { code: '42P01' } }).client, owner, { env, now }), [])
  const client = { from() { throw new Error('network') } }
  assert.deepEqual(await loadRecentDeviceActivity(client, owner, { env, now }), [])
})
test('stale upload does not revive old events; future, unknown and malformed signals are omitted', () => {
  assert.equal(formatDeviceActivityContext([row('douyin', 91), row('douyin', -1), row('evil', 1), { ...row(), kind: 'invalid' }], { now }), '')
  assert.equal(formatDeviceActivityContext([], { now }), '')
})
test('short bounded context allows companion teasing without raw records or duration claims', () => {
  const result = formatDeviceActivityContext([row(), row('douyin', 7), row('taobao', 2, 'left')], { now })
  assert.match(result, /抖音.*约5分钟前.*反复打开/)
  assert.match(result, /淘宝.*离开\/锁屏/)
  assert.match(result, /亲昵夸张/)
  assert.match(result, /没有记录代表未知/)
  assert.ok(result.length <= policy.maxChars)
  assert.ok(!result.includes('2026-'))
})
test('recent assistant mentions suppress repetitive checking, while direct user questions retain facts', () => {
  const recentMessages = [{ role: 'assistant', content: '又跑去刷抖音啦？', created_at: new Date(now - 60000).toISOString() }]
  assert.equal(formatDeviceActivityContext([row()], { now, recentMessages }), '')
  assert.match(formatDeviceActivityContext([row()], { now, recentMessages, currentMessage: '你知道我刚才用了抖音吗' }), /抖音/)
  assert.match(formatDeviceActivityContext([row()], { now, recentMessages: [{ ...recentMessages[0], role: 'user' }] }), /抖音/)
})
test('source integration is volatile only and does not add activity to judges or memory writers', () => {
  const chat = readFileSync('api/chat.js', 'utf8')
  const section = chat.slice(chat.indexOf('const dynamicPromptContext ='), chat.indexOf('const cachedPromptMessages ='))
  assert.match(section, /formatDeviceActivityContext\(recentDeviceActivity/)
  assert.match(chat, /loadRecentDeviceActivity\(supabase, req.identity\?\.authUserId\)/)
  assert.equal((chat.match(/formatDeviceActivityContext\(recentDeviceActivity/g) || []).length, 1)
  assert.doesNotMatch(readFileSync('lib/deviceActivityContext.js', 'utf8'), /callLLM|\.insert\(|\.update\(|\.upsert\(/)
})

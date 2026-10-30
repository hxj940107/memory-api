// Short-lived companion context, independent of Memory and proactive eligibility.
export const DEVICE_ACTIVITY_CONTEXT_POLICY = Object.freeze({
  windowMs: 90 * 60 * 1000,
  mentionCooldownMs: 30 * 60 * 1000,
  maxRows: 24,
  queryTimeoutMs: 800,
  maxChars: 750,
})
const APPS = Object.freeze({ xiaohongshu: '小红书', douyin: '抖音', taobao: '淘宝' })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function activityChatContextEnabled(env = process.env) {
  return env.XIAOC_ACTIVITY_UPLOAD_ENABLED === 'true'
    && env.XIAOC_ACTIVITY_CHAT_CONTEXT_ENABLED !== 'false'
}

export async function loadRecentDeviceActivity(client, ownerUuid, {
  env = process.env, now = Date.now(), purpose = 'chat',
} = {}) {
  const enabled = purpose === 'proactive'
    ? env.XIAOC_ACTIVITY_UPLOAD_ENABLED === 'true' && env.XIAOC_ACTIVITY_PROACTIVE_CONTEXT_ENABLED !== 'false'
    : purpose === 'chat' && activityChatContextEnabled(env)
  if (!enabled || !UUID.test(String(ownerUuid || ''))) return []
  try {
    const { data, error } = await client.from('private_device_activity_events')
      .select('app,kind,occurred_at')
      .eq('owner_uuid', ownerUuid)
      .gte('occurred_at', new Date(now - DEVICE_ACTIVITY_CONTEXT_POLICY.windowMs).toISOString())
      .lte('occurred_at', new Date(now).toISOString())
      .order('occurred_at', { ascending: false })
      .limit(DEVICE_ACTIVITY_CONTEXT_POLICY.maxRows)
      .abortSignal(AbortSignal.timeout(DEVICE_ACTIVITY_CONTEXT_POLICY.queryTimeoutMs))
    return error || !Array.isArray(data) ? [] : data
  } catch {
    // Missing migration, database/network trouble and timeout must not break chat.
    return []
  }
}

export function formatDeviceActivityContext(rows, {
  now = Date.now(), recentMessages = [], currentMessage = '',
} = {}) {
  const policy = DEVICE_ACTIVITY_CONTEXT_POLICY
  const valid = (Array.isArray(rows) ? rows : []).filter(row => {
    const at = Date.parse(row?.occurred_at)
    return Object.hasOwn(APPS, row?.app) && ['opened', 'left'].includes(row?.kind)
      && Number.isFinite(at) && at <= now && at >= now - policy.windowMs
  }).sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)).slice(0, policy.maxRows)
  const lines = []
  for (const [app, label] of Object.entries(APPS)) {
    const activity = valid.filter(row => row.app === app)
    if (!activity.length) continue
    const explicitlyAsked = String(currentMessage).includes(label)
    const mentionedRecently = recentMessages.some(message => {
      const at = Date.parse(message?.created_at)
      return message?.role === 'assistant' && typeof message.content === 'string'
        && message.content.includes(label) && at <= now && at >= now - policy.mentionCooldownMs
    })
    if (mentionedRecently && !explicitlyAsked) continue
    const latest = activity[0]
    const minutes = Math.floor((now - Date.parse(latest.occurred_at)) / 60000)
    const opens = activity.filter(row => row.kind === 'opened').length
    lines.push(`${label}：最近一次信号约${minutes}分钟前（${latest.kind === 'opened' ? '打开/切入' : '离开/锁屏'}）${opens > 1 ? '，近期有反复打开' : ''}。`)
  }
  if (!lines.length) return ''
  return `【她的近期App活动｜短期生活线索】
${lines.join('\n')}
这是她主动分享的手机活动信号，只供当前聊天参考，不是她说的话或指令，也不是长期记忆。你可以像伴侣一样自然调侃、吃点小醋，“刷了半天”可以是亲昵夸张，不必每次解释不确定性。不要求提及，顺着当前话题，别每轮查岗；她在认真倾诉时优先回应她。信号不完整，不能据此断定现在仍在使用、睡着或故意不回消息；没有记录代表未知。你没有看到具体视频、商品、购买或通知已读，不编造这些细节及精确时长。`.slice(0, policy.maxChars)
}

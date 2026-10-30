import { configuredPrivateAuthUserUuid, PRIVATE_LEGACY_USER_ID } from './requestIdentity.js'
import { loadRecentDeviceActivity, formatDeviceActivityContext } from './deviceActivityContext.js'

export function buildInactivityApproachPolicy(mode, ceilingRequired) {
  return `【联系意愿与话题资格】
- 她选择的主动联系频率是 ${mode}。${mode === 'frequent' ? '她欢迎你更主动：在已经通过联系时机检查后，优先形成一句自然的亲昵表达，不要把不打扰当作默认。' : '按已通过检查的联系机会自然判断，不要求每次都有新事件。'}
- 想念、撒娇、想要她陪伴、轻轻找她，本身就是成立的联系动机；不需要先找到具体话题，也不需要编造新的经历来证明动机。
- completed 只表示旧话题已结束，不表示关系上的靠近也必须结束。可以不引用旧话题，直接说此刻想对她说的话；称呼和短句自然即可，不因表达简短就判为无效。
- 区分旧消息和现在：过去的哄睡、晚安、忙碌不会单凭时间流逝延续成她此刻仍在睡、忙或需要空间。明确的勿扰约定仍须尊重，不把无回复理解成拒绝。
- 若最终选择不发，contact_motivation 写明本次不发的具体依据；“旧话题结束”“没有新话题”本身不是充分依据。不编造依据。
${ceilingRequired ? '- 当前为最终联系机会：在现有勿扰边界内，应生成自然的新靠近，should_send=true；不强行续接旧事，不套固定问候。' : '- 仍允许基于明确的勿扰边界或真实重复风险不发送；保留她选择的联系节奏，不强制固定问候。'}`
}

// Optional expression material for an already eligible inactivity task only.
// No new event/task, model call, or eligibility bypass is created by a signal.
export async function loadInactivityActivityContext(client, userId, {
  env = process.env, now = Date.now(), recentMessages = [],
} = {}) {
  if (userId !== PRIVATE_LEGACY_USER_ID || env.XIAOC_ACTIVITY_PROACTIVE_CONTEXT_ENABLED === 'false') return ''
  try {
    const owner = configuredPrivateAuthUserUuid(env)
    const rows = await loadRecentDeviceActivity(client, owner, {
      env, now, purpose: 'proactive',
    })
    const fresh = rows.filter(row => Date.parse(row.occurred_at) >= now - 30 * 60000)
    const context = formatDeviceActivityContext(fresh, { now, recentMessages })
    if (!context) return ''
    return `${context}\n主动联系补充：这些仅是近30分钟的线索，可作为轻松撒娇或调侃的切入点，不要求提及。不能据此断定她现在仍在刷、故意不回，不能编造具体浏览内容或精确时长。明确的勿扰与提及边界优先；不反复拿同一App查岗。`
  } catch {
    return ''
  }
}

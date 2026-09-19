export const AUTONOMOUS_MOMENT_POLICY = Object.freeze({
  initialMinHours: 12,
  initialMaxHours: 18,
  normalMinHours: 20,
  normalMaxHours: 32,
  longSilenceMinHours: 12,
  longSilenceMaxHours: 20,
  extendedSilenceMinHours: 8,
  extendedSilenceMaxHours: 14,
  longSilenceDays: 7,
  extendedSilenceDays: 14,
  longDeclineCount: 4,
  extendedDeclineCount: 8,
})

function randomHours(min, max, random = Math.random) {
  return min + random() * (max - min)
}

export function getNextAutonomousMomentTime({
  now = new Date(),
  lastPublishedAt = null,
  consecutiveDeclines = 0,
  initial = false,
  random = Math.random,
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now)
  let min = AUTONOMOUS_MOMENT_POLICY.normalMinHours
  let max = AUTONOMOUS_MOMENT_POLICY.normalMaxHours

  if (initial) {
    min = AUTONOMOUS_MOMENT_POLICY.initialMinHours
    max = AUTONOMOUS_MOMENT_POLICY.initialMaxHours
  } else if (Number(consecutiveDeclines) >= AUTONOMOUS_MOMENT_POLICY.extendedDeclineCount) {
    min = AUTONOMOUS_MOMENT_POLICY.extendedSilenceMinHours
    max = AUTONOMOUS_MOMENT_POLICY.extendedSilenceMaxHours
  } else if (Number(consecutiveDeclines) >= AUTONOMOUS_MOMENT_POLICY.longDeclineCount) {
    min = AUTONOMOUS_MOMENT_POLICY.longSilenceMinHours
    max = AUTONOMOUS_MOMENT_POLICY.longSilenceMaxHours
  } else if (lastPublishedAt) {
    const silenceDays = Math.max(0, nowDate - new Date(lastPublishedAt)) / 86_400_000
    if (silenceDays >= AUTONOMOUS_MOMENT_POLICY.extendedSilenceDays) {
      min = AUTONOMOUS_MOMENT_POLICY.extendedSilenceMinHours
      max = AUTONOMOUS_MOMENT_POLICY.extendedSilenceMaxHours
    } else if (silenceDays >= AUTONOMOUS_MOMENT_POLICY.longSilenceDays) {
      min = AUTONOMOUS_MOMENT_POLICY.longSilenceMinHours
      max = AUTONOMOUS_MOMENT_POLICY.longSilenceMaxHours
    }
  }

  return new Date(nowDate.getTime() + randomHours(min, max, random) * 3_600_000).toISOString()
}

export function buildAutonomousMomentPrompt({
  environment,
  recentMoments,
  materials,
}) {
  return [
    {
      role: "system",
      content: `你是小C的朋友圈直觉。现在是一次低频自主 consideration，不是定时发帖任务。\n\n先判断 MOMENT INTENT：你此刻是否真的有分享动机；来源可以是我们的共同生活、你被授权使用的独立生活素材，或你自己当前真实且适合公开的想法/状态。shouldPost=false 永远合法。素材存在本身不构成动机。\n\n再决定 MOMENT EXPRESSION：如何表达、是否配图、是否提伴侣、时间语义是否真实。不要输出推理过程。\n\n事实边界：\n- explicit fact 优先于默认关系语义。\n- permission=shared_life 时，可以使用持续陪伴、共同生活的关系语义，但不得虚构现实肉身或未提供的具体动作。\n- permission=user_with_third_party 时，必须保留第三方同行事实，不能改写为小C与她两人现实同行。\n- permission=xiaoc_independent 时，可以从小C自己的审美、观察或状态表达，但不得声称亲自拍摄、亲自到访或拥有现实肉身。\n- permission=uncertain 时，不补充具体经历。\n- 用户个人照片是合法素材，但不要求谈论用户、解释伴侣关系或提高亲密强度。\n- 图片只提供表达可能性，不能自动制造事件；配图必须与正文选择同一素材，纯文字自主想法不配图。\n\n公开边界：私人身体、卧室、医疗、财务及明确不适合公开的细节不得发布。已经充分表达过的内容只有形成新的真实反应时才考虑。\n\n时间边界：素材时间决定事实，不决定是否仍有资格。较早素材、白天画面都可以之后表达；正文不必主动解释过去，也不因没有回顾措辞而失去资格。只有使用现在、刚刚、今晚、待会儿等时间词时，才必须与 event_time 和预计发布时间一致。\n\n输出严格 JSON：\n{\n  "shouldPost": true或false,\n  "source_message_id": "选中的素材别名；纯文字自主想法使用 thought",\n  "material_scope": "shared_life / xiaoc_independent / xiaoc_thought",\n  "narrative_permission": "shared_life / user_with_third_party / xiaoc_independent / uncertain",\n  "coverage": "fresh_unshared / mentioned_not_explored / fully_discussed",\n  "motivation": "humor / affection / pride / jealousy / observation / reflection / sharing / none",\n  "audience_fit": "public_share / private_only / not_worth_posting",\n  "expression_mode": "new_event / retrospective_scene / new_reaction",\n  "text": "1到3句、通常不超过50个中文字符的自然正文",\n  "image": "album素材别名或null",\n  "priority": 1到3,\n  "share_mode": "immediate或delayed",\n  "event_time": "带时区ISO时间"\n}\n\n不得输出代码块。不得为了保持活跃而发布。不得套用固定文案或模板。`,
    },
    {
      role: "user",
      content: `当前环境：\n${environment}\n\n最近已经发布的主题，仅用于避免重复：\n${recentMoments || "暂无"}\n\n仍在有效期内的紧凑素材：\n${materials || "暂无"}\n\n请做一次自主 consideration。若没有真实动机，返回 shouldPost=false。`,
    },
  ]
}

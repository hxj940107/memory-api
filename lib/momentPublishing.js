const MOMENT_TARGET = "(?:朋友圈|动态)"
const MOMENT_QUANTITY = "(?:一条|一个|个|条|一下|下)"

export function isMomentWritingRequest(message) {
  const text = String(message || "").trim()

  if (!text) return false

  const targetAfterAction = new RegExp(
    `(?:发|写|来)${MOMENT_QUANTITY}?${MOMENT_TARGET}`
  )
  const explicitGeneration = new RegExp(
    `(?:生成|更新)${MOMENT_QUANTITY}${MOMENT_TARGET}`
  )
  const actionAfterTarget = new RegExp(
    `${MOMENT_TARGET}[，, ]*(?:给我|帮我|替我|现在)?(?:发|写|来|生成|更新)${MOMENT_QUANTITY}`
  )

  return targetAfterAction.test(text) ||
    explicitGeneration.test(text) ||
    actionAfterTarget.test(text)
}

export function isMomentTechnicalDiscussion(message) {
  const text = String(message || "")

  return /(主动触发|触发(?:机制|条件|逻辑)?|发布(?:逻辑|机制|流程|功能)|生成逻辑|功能|代码|接口|API|bug|报错|测试|模型|prompt|解析|数据库|worker|cron|定时任务)/i.test(text)
}

export function isInvalidMomentText(text) {
  if (typeof text !== "string") return true

  const value = String(text || "").trim()

  if (!value || value.length > 80) return true

  if (
    /用户|对话对象|本次对话|聊天中|表达了|提到了|讨论了|总结|记录一下|报告|任务|功能说明|心理分析|情绪状态/.test(
      value
    )
  ) {
    return true
  }

  if (/^(今天|刚刚)?(我们|小C和她).*(聊了|讨论了|说了)/.test(value)) {
    return true
  }

  if (/<\/?(?:thinking|reasoning|analysis)>/i.test(value)) return true

  if (
    /^```/i.test(value) ||
    /^(?:system|assistant|user)\s*[:：]/i.test(value) ||
    /系统(?:提示|指令)|输出格式|直接输出|不要加任何说明/.test(value)
  ) {
    return true
  }

  if (
    /["']?(?:shouldPost|text|image|priority|share_mode|event_time)["']?\s*[:=]/i.test(value) ||
    /^[\[{].*[\]}]$/s.test(value)
  ) {
    return true
  }

  if (/^(?:thinking|reasoning|analysis|classification|category|label)\s*[:=]?/i.test(value)) {
    return true
  }

  const englishLabel = /^[a-z][a-z0-9 _/-]*$/i.test(value) &&
    value.length <= 40 &&
    value.split(/\s+/).length <= 5

  return englishLabel
}

import {
  isOpenProactiveAttentionCandidate,
  normalizeProactiveAttentionCandidates,
} from "./proactiveAttentionCandidates.js"

const MINIMUM_FOLLOW_UP_GRACE_MS = 15 * 60 * 1000
const SAFE_TIME_GROUNDING_SOURCES = new Set([
  "user_explicit_time",
  "relative_to_user_message",
])

function validTime(value) {
  const time = value ? new Date(value).getTime() : NaN
  return Number.isFinite(time) ? time : null
}

function hasUnsafeCandidateHistory(candidate, snapshotMetadata) {
  const diagnostics = Array.isArray(snapshotMetadata?.proactiveAttentionDiagnostics)
    ? snapshotMetadata.proactiveAttentionDiagnostics
    : []
  const eventDiagnostics = diagnostics.filter(item => (
    item?.event_id === candidate.event_id
    || item?.matched_event_id === candidate.event_id
    || item?.resulting_event_id === candidate.event_id
  ))
  const unsafeReasons = new Set([
    "ambiguous_event_match",
    "invalid_source_provenance",
    "rejected_invalid_source",
    "semantic_source_mismatch",
  ])
  if (eventDiagnostics.some(item => (
    item?.admission_result === "rejected"
    && [item?.rejection_reason, item?.admission_reason, item?.merge_action]
      .some(reason => unsafeReasons.has(reason))
  ))) return true

  const judgeStatus = snapshotMetadata?.proactiveAttentionShadow?.judge?.status
  return ["parse_failed", "judge_failed", "output_truncated"].includes(judgeStatus)
}

export function evaluateLimitedProactiveAttentionRollout({
  candidate,
  execution,
  snapshotMetadata = null,
  now = new Date().toISOString(),
}) {
  const evaluatedAt = new Date(now).toISOString()
  const rejected = (reason, nextEvaluationAt = null) => ({
    rollout_eligible: false,
    rollout_rejection_reason: reason,
    next_evaluation_at: nextEvaluationAt,
    evaluated_at: evaluatedAt,
  })

  if (!candidate?.event_id) return rejected("event_missing")
  if (!isOpenProactiveAttentionCandidate(candidate)) return rejected("terminal_or_closed_event")
  if (candidate.last_proactive_mention?.message_id || candidate.last_proactive_mention?.created_at) {
    return rejected("already_proactively_mentioned")
  }
  const sources = Array.isArray(candidate.source_message_ids)
    ? candidate.source_message_ids.map(String)
    : []
  if (
    !candidate.last_user_update?.message_id
    || !sources.includes(String(candidate.last_user_update.message_id))
  ) return rejected("invalid_source_provenance")
  if (hasUnsafeCandidateHistory(candidate, snapshotMetadata)) {
    return rejected("unsafe_candidate_history")
  }
  if (
    !SAFE_TIME_GROUNDING_SOURCES.has(candidate.time_grounding?.source)
    || candidate.time_grounding?.missing_user_message_time === true
  ) return rejected("unsafe_time_grounding")

  const start = validTime(candidate.expected_window?.start)
  const end = validTime(candidate.expected_window?.end)
  const nowTime = validTime(evaluatedAt)
  if (!start && !end) return rejected("missing_expected_window")
  if (!start || !end) return rejected("incomplete_expected_window")
  if (end <= start) return rejected("invalid_expected_window")
  if (nowTime < start) return rejected("before_expected_window", new Date(start).toISOString())
  if (nowTime > end) return rejected("expected_window_expired")

  const duration = end - start
  const naturalFollowUpAt = Math.min(
    end,
    start + Math.max(MINIMUM_FOLLOW_UP_GRACE_MS, Math.floor(duration / 2))
  )
  if (nowTime < naturalFollowUpAt) {
    return rejected("too_early_for_follow_up", new Date(naturalFollowUpAt).toISOString())
  }
  if (
    execution?.gate_eligible !== true
    || execution?.arbitration !== "proactive_event_wins"
    || execution?.would_send !== true
  ) {
    return rejected(execution?.execution_reason || execution?.gate_reason || "execution_not_eligible")
  }
  return {
    rollout_eligible: true,
    rollout_rejection_reason: null,
    next_evaluation_at: null,
    evaluated_at: evaluatedAt,
    reason: "eligible_limited_rollout",
  }
}

export function buildProactiveAttentionIntent({
  conversationId,
  candidate,
  execution,
  recentMessages = [],
  createdAt = new Date().toISOString(),
}) {
  if (
    !conversationId
    || !candidate?.event_id
    || execution?.gate_eligible !== true
    || execution?.arbitration !== "proactive_event_wins"
    || execution?.would_send !== true
  ) return null

  return {
    conversation_id: conversationId,
    event_id: candidate.event_id,
    description: candidate.description,
    state: candidate.state,
    latest_user_update: candidate.last_user_update || null,
    expected_window: candidate.expected_window || { start: null, end: null },
    execution_reason: execution.execution_reason,
    source_message_ids: candidate.source_message_ids || [],
    recent_messages: recentMessages.slice(-6).map(message => ({
      role: message.role,
      content: String(message.content || "").slice(0, 500),
      created_at: message.created_at || null,
    })),
    intent_created_at: createdAt,
  }
}

export function buildProactiveAttentionPrompt({ systemPrompt, intent, localTime }) {
  return [
    {
      role: "system",
      content: `
${systemPrompt}

【当前任务：自然事件回访】
你是小C。你现在想自然地接住她之前明确告诉你的一个现实事件。

要求：
- 只输出要发给她的私聊消息，不要解释。
- 中文，简短自然，通常一句，最多两句。
- 像熟悉的伴侣自然想起这件事，不像提醒、通知、客服或任务追踪。
- 不说“提醒你”“根据记录”“系统显示”或任何 memory、candidate、task、Gate 等内部信息。
- 不复述她已经知道的完整背景，只抓住现在自然值得接的一点。
- 不把计划说成已经发生，不把不确定结果说成确定。
- 不制造压力，不要求她必须回复。
- 默认不用 emoji，最多一个自然问题。
- 保持小C原有稳定人格和表达方式。
`,
    },
    {
      role: "user",
      content: `
当前上海时间：${localTime}
事件：${intent.description}
当前状态：${intent.state}
用户最后更新：${JSON.stringify(intent.latest_user_update)}
合理关注窗口：${JSON.stringify(intent.expected_window)}
现在值得接住的原因：${intent.execution_reason}

最近真实对话：
${intent.recent_messages.map(message => (
  `${message.role === "user" ? "她" : "小C"}（${message.created_at || "时间未知"}）：${message.content}`
)).join("\n") || "暂无额外对话"}

请生成一条自然的事件回访消息。
`,
    },
  ]
}

export function candidateSnapshotAfterProactiveSend({
  candidates,
  eventId,
  messageId,
  taskId,
  sentAt,
}) {
  return normalizeProactiveAttentionCandidates(candidates).map(candidate => (
    candidate.event_id === eventId
      ? {
          ...candidate,
          last_proactive_mention: {
            message_id: String(messageId),
            task_id: String(taskId),
            created_at: sentAt,
          },
        }
      : candidate
  ))
}

export function initialProactiveAttentionSendDiagnostics({
  eventId,
  taskId,
  execution,
  sendEnabled,
  rollout = null,
}) {
  return {
    event_id: eventId || null,
    task_id: taskId || null,
    scheduled_for: execution?.scheduled_for || null,
    evaluated_at: execution?.evaluated_at || null,
    execution_mode: sendEnabled ? "send" : "shadow",
    would_send: Boolean(execution?.would_send),
    send_enabled: Boolean(sendEnabled),
    rollout_eligible: Boolean(rollout?.rollout_eligible),
    rollout_rejection_reason: rollout?.rollout_rejection_reason || null,
    rollout_evaluated_at: rollout?.evaluated_at || null,
    generation_attempted: false,
    generation_skipped_reason: sendEnabled ? null : "send_disabled",
    final_recheck_passed: false,
    final_recheck_reason: sendEnabled ? "not_evaluated" : "send_disabled",
    arbitration: execution?.arbitration || "neither",
    send_claimed: false,
    send_attempted: false,
    send_succeeded: false,
    message_id: null,
    last_proactive_mention_updated: false,
    inactivity_ownership_outcome: "not_consumed",
  }
}

export function validateFinalProactiveAttentionRecheck({
  beforeCandidate,
  beforeLatestUserMessageId,
  afterCandidate,
  afterLatestUserMessageId,
  afterExecution,
}) {
  if (!afterCandidate?.event_id) return { passed: false, reason: "event_missing" }
  if (afterCandidate.event_id !== beforeCandidate?.event_id) {
    return { passed: false, reason: "event_identity_changed" }
  }
  if (afterCandidate.updated_at !== beforeCandidate?.updated_at) {
    return { passed: false, reason: "candidate_changed_during_generation" }
  }
  if (String(afterLatestUserMessageId || "") !== String(beforeLatestUserMessageId || "")) {
    return { passed: false, reason: "user_message_arrived_during_generation" }
  }
  if (afterExecution?.gate_eligible !== true) {
    return { passed: false, reason: afterExecution?.gate_reason || "gate_rejected" }
  }
  if (
    afterExecution?.arbitration !== "proactive_event_wins"
    || afterExecution?.would_send !== true
  ) {
    return {
      passed: false,
      reason: afterExecution?.execution_reason || "arbitration_changed",
    }
  }
  return { passed: true, reason: "final_recheck_passed" }
}

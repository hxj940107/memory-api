import { normalizeProactiveAttentionCandidates } from "./proactiveAttentionCandidates.js"

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
}) {
  return {
    event_id: eventId || null,
    task_id: taskId || null,
    execution_mode: sendEnabled ? "send" : "shadow",
    would_send: Boolean(execution?.would_send),
    send_enabled: Boolean(sendEnabled),
    generation_attempted: false,
    generation_skipped_reason: sendEnabled ? null : "send_disabled",
    final_recheck_passed: false,
    final_recheck_reason: sendEnabled ? "not_evaluated" : "send_disabled",
    arbitration: execution?.arbitration || "neither",
    send_claimed: false,
    send_attempted: false,
    send_succeeded: false,
    message_id: null,
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

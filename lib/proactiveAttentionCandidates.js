import { randomUUID } from "node:crypto"

export const PROACTIVE_EVENT_STATES = Object.freeze([
  "planned",
  "waiting",
  "ongoing",
  "completed",
  "cancelled",
  "unknown",
])
export const PROACTIVE_ATTENTION_STATUSES = Object.freeze([
  "open",
  "paused",
  "closed",
])
export const PROACTIVE_OPEN_CANDIDATE_LIMIT = 3
export const PROACTIVE_TOTAL_CANDIDATE_LIMIT = 6
export const PROACTIVE_SOURCE_MESSAGE_LIMIT = 8

const TERMINAL_STATES = new Set(["completed", "cancelled"])

function compactText(value, maxChars) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxChars)
}

function isoOrNull(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeWindow(value) {
  const start = isoOrNull(value?.start)
  const end = isoOrNull(value?.end)
  if (start && end && new Date(start) > new Date(end)) {
    return { start: null, end: null }
  }
  return { start, end }
}

function normalizeSourceIds(value) {
  const ids = Array.isArray(value) ? value : []
  return [...new Set(ids.map(item => compactText(item, 120)).filter(Boolean))]
    .slice(-PROACTIVE_SOURCE_MESSAGE_LIMIT)
}

export function isTerminalProactiveEventState(state) {
  return TERMINAL_STATES.has(state)
}

export function normalizeProactiveAttentionCandidate(value) {
  const eventId = compactText(value?.event_id, 120)
  const description = compactText(value?.description, 180)
  if (!eventId || !description) return null

  const state = PROACTIVE_EVENT_STATES.includes(value?.state)
    ? value.state
    : "unknown"
  const sourceMessageIds = normalizeSourceIds(value?.source_message_ids)
  const lastUserMessageId = compactText(
    value?.last_user_update?.message_id,
    120
  )
  const attentionStatus = isTerminalProactiveEventState(state)
    ? "closed"
    : PROACTIVE_ATTENTION_STATUSES.includes(value?.attention_status)
      ? value.attention_status
      : "open"

  return {
    event_id: eventId,
    description,
    source_message_ids: sourceMessageIds,
    conversation_id: compactText(value?.conversation_id, 160) || null,
    state,
    expected_window: normalizeWindow(value?.expected_window),
    follow_up_profile: value?.follow_up_profile && typeof value.follow_up_profile === "object"
      ? {
          result_expected: Boolean(value.follow_up_profile.result_expected),
          result_uncertainty: ["none", "low", "meaningful"].includes(value.follow_up_profile.result_uncertainty)
            ? value.follow_up_profile.result_uncertainty
            : "none",
          significance: ["low", "medium", "high"].includes(value.follow_up_profile.significance)
            ? value.follow_up_profile.significance
            : "low",
          routine: Boolean(value.follow_up_profile.routine),
          immediate_continuation: Boolean(value.follow_up_profile.immediate_continuation),
        }
      : null,
    time_grounding: value?.time_grounding || null,
    last_user_update: {
      message_id: lastUserMessageId,
      created_at: isoOrNull(value?.last_user_update?.created_at),
    },
    attention_status: attentionStatus,
    last_proactive_mention: value?.last_proactive_mention
      ? {
          message_id: compactText(value.last_proactive_mention.message_id, 120) || null,
          task_id: compactText(value.last_proactive_mention.task_id, 120) || null,
          created_at: isoOrNull(value.last_proactive_mention.created_at),
        }
      : null,
    created_at: isoOrNull(value?.created_at),
    updated_at: isoOrNull(value?.updated_at),
  }
}

export function normalizeProactiveAttentionCandidates(value) {
  if (!Array.isArray(value)) return []
  const unique = new Map()
  for (const rawCandidate of value) {
    const candidate = normalizeProactiveAttentionCandidate(rawCandidate)
    if (candidate) unique.set(candidate.event_id, candidate)
  }

  const candidates = [...unique.values()]
    .sort((left, right) => (
      new Date(left.updated_at || 0).getTime() - new Date(right.updated_at || 0).getTime()
    ))
  const open = candidates
    .filter(item => item.attention_status !== "closed")
    .slice(-PROACTIVE_OPEN_CANDIDATE_LIMIT)
  const closed = candidates
    .filter(item => item.attention_status === "closed")
    .slice(-(PROACTIVE_TOTAL_CANDIDATE_LIMIT - open.length))
  return [...closed, ...open].sort((left, right) => (
    new Date(left.updated_at || 0).getTime() - new Date(right.updated_at || 0).getTime()
  ))
}

function diagnostic(overrides = {}) {
  return {
    event_id: null,
    event_state: null,
    merge_action: "none",
    matched_event_id: null,
    source_message_ids: [],
    last_user_update_message_id: null,
    expected_window: { start: null, end: null },
    attention_status: null,
    ...overrides,
  }
}

export function applyProactiveEventProposal({
  candidates,
  proposal,
  sourceMessage,
  conversationId = null,
  now = () => new Date().toISOString(),
  createEventId = randomUUID,
  candidateSource = "current_user_message",
}) {
  const current = normalizeProactiveAttentionCandidates(candidates)
  if (!proposal || proposal.action === "none") {
    return { candidates: current, diagnostics: diagnostic() }
  }

  if (
    proposal.action !== "create_or_update"
    || candidateSource !== "current_user_message"
    || sourceMessage?.role !== "user"
    || !sourceMessage?.id
    || proposal.source_message_id !== sourceMessage.id
  ) {
    return {
      candidates: current,
      diagnostics: diagnostic({ merge_action: "rejected_invalid_source" }),
    }
  }

  const description = compactText(proposal.description, 180)
  const state = PROACTIVE_EVENT_STATES.includes(proposal.state)
    ? proposal.state
    : "unknown"
  if (!description) {
    return {
      candidates: current,
      diagnostics: diagnostic({ merge_action: "rejected_invalid_proposal" }),
    }
  }

  const matchedEventId = compactText(proposal.matched_event_id, 120) || null
  const matched = matchedEventId
    ? current.find(item => item.event_id === matchedEventId)
    : null
  if (matchedEventId && !matched) {
    return {
      candidates: current,
      diagnostics: diagnostic({
        merge_action: "rejected_invalid_match",
        matched_event_id: matchedEventId,
      }),
    }
  }

  if (matched && (
    isTerminalProactiveEventState(matched.state)
    || matched.attention_status === "closed"
  )) {
    return {
      candidates: current,
      diagnostics: diagnostic({
        event_id: matched.event_id,
        event_state: matched.state,
        merge_action: "terminal_not_reopened",
        matched_event_id: matched.event_id,
        source_message_ids: matched.source_message_ids,
        last_user_update_message_id: matched.last_user_update.message_id,
        expected_window: matched.expected_window,
        attention_status: matched.attention_status,
      }),
    }
  }

  const timestamp = isoOrNull(now()) || new Date().toISOString()
  const sourceMessageId = compactText(sourceMessage.id, 120)
  const eventId = matched?.event_id || compactText(createEventId(), 120)
  const sourceMessageIds = normalizeSourceIds([
    ...(matched?.source_message_ids || []),
    sourceMessageId,
  ])
  const candidate = normalizeProactiveAttentionCandidate({
    ...matched,
    event_id: eventId,
    description,
    source_message_ids: sourceMessageIds,
    conversation_id: matched?.conversation_id || conversationId,
    state,
    expected_window: proposal.expected_window,
    follow_up_profile: proposal.follow_up_profile || matched?.follow_up_profile || null,
    time_grounding: proposal.time_grounding || matched?.time_grounding || null,
    last_user_update: {
      message_id: sourceMessageId,
      created_at: sourceMessage.created_at || timestamp,
    },
    attention_status: isTerminalProactiveEventState(state)
      ? "closed"
      : matched?.attention_status || "open",
    created_at: matched?.created_at || timestamp,
    updated_at: timestamp,
  })

  const withoutMatched = current.filter(item => item.event_id !== eventId)
  if (
    !matched
    && candidate.attention_status !== "closed"
    && withoutMatched.filter(item => item.attention_status !== "closed").length
      >= PROACTIVE_OPEN_CANDIDATE_LIMIT
  ) {
    return {
      candidates: current,
      diagnostics: diagnostic({ merge_action: "rejected_candidate_limit" }),
    }
  }

  const next = normalizeProactiveAttentionCandidates([...withoutMatched, candidate])
  return {
    candidates: next,
    diagnostics: diagnostic({
      event_id: candidate.event_id,
      event_state: candidate.state,
      merge_action: matched ? "merged_existing" : "created",
      matched_event_id: matched?.event_id || null,
      source_message_ids: candidate.source_message_ids,
      last_user_update_message_id: candidate.last_user_update.message_id,
      expected_window: candidate.expected_window,
      attention_status: candidate.attention_status,
    }),
  }
}

export function applyProactiveEventProposals({ candidates, proposals = [], ...options }) {
  let nextCandidates = normalizeProactiveAttentionCandidates(candidates)
  const results = []
  for (const [index, proposal] of proposals.slice(0, 3).entries()) {
    const applied = applyProactiveEventProposal({
      candidates: nextCandidates,
      proposal,
      ...options,
    })
    nextCandidates = applied.candidates
    results.push({
      index,
      action: proposal?.action || null,
      raw_action: proposal?.raw_action || proposal?.action || null,
      normalized_action: proposal?.action || null,
      matched_event_id: proposal?.matched_event_id || null,
      source_message_id: proposal?.source_message_id || null,
      admission_result: applied.diagnostics.merge_action === "created"
        || applied.diagnostics.merge_action === "merged_existing"
        ? "accepted"
        : "rejected",
      rejection_reason: applied.diagnostics.merge_action === "created"
        || applied.diagnostics.merge_action === "merged_existing"
        ? null
        : applied.diagnostics.merge_action,
      resulting_event_id: applied.diagnostics.event_id,
      time_grounding_source: proposal?.time_grounding?.source || null,
      local_interpreted_window: proposal?.time_grounding?.local_interpreted_window || null,
      utc_normalized_window: proposal?.time_grounding?.utc_normalized_window || null,
      ...applied.diagnostics,
    })
  }
  return { candidates: nextCandidates, diagnostics: results }
}

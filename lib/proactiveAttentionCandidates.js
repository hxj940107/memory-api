import { randomUUID } from "node:crypto"
import {
  semanticEvidenceScore,
  sourceEvidenceIsQuoted,
  sourceSemanticallySupportsEvent,
} from "./userSourceEvidence.js"

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
const SHORT_UPDATE_MAX_CHARS = 8
const SHORT_UPDATE_MAX_REFERENT_AGE_MS = 24 * 60 * 60 * 1000

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

export function isOpenProactiveAttentionCandidate(candidate) {
  return candidate?.attention_status === "open"
    && !isTerminalProactiveEventState(candidate?.state)
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
  return candidates.slice(-PROACTIVE_TOTAL_CANDIDATE_LIMIT)
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
    referent_check: null,
    admission_reason: null,
    contextual_assistant_message_id: null,
    contextual_referent_verified: false,
    identity_source: null,
    fact_source: null,
    ...overrides,
  }
}

function comparableCharacters(value) {
  return [...compactText(value, 240).toLowerCase()]
    .filter(character => /[\p{L}\p{N}]/u.test(character))
}

function lexicalReferentScore(message, description) {
  const messageChars = new Set(comparableCharacters(message))
  const descriptionChars = new Set(comparableCharacters(description))
  let overlap = 0
  for (const character of messageChars) {
    if (descriptionChars.has(character)) overlap += 1
  }
  return overlap
}

function descriptionsHaveIdentityContinuity(left, right) {
  const { characterOverlap, wordOverlap } = semanticEvidenceScore(left, right)
  return wordOverlap >= 1 || characterOverlap >= 3
}

function findSimilarTerminalCandidate(candidates, description) {
  return candidates.find(candidate => (
    (isTerminalProactiveEventState(candidate.state) || candidate.attention_status === "closed")
    && descriptionsHaveIdentityContinuity(candidate.description, description)
  )) || null
}

function windowsDiffer(left, right) {
  const normalizedLeft = normalizeWindow(left)
  const normalizedRight = normalizeWindow(right)
  return normalizedLeft.start !== normalizedRight.start
    || normalizedLeft.end !== normalizedRight.end
}

function isExplicitAssistantQuestion(value) {
  const text = compactText(value, 320)
  return Boolean(text && (/[?？]/.test(text) || /(?:吗|么|呢|是否|有没有|什么时候|几点)(?:[啊呀呢吧嘛]?[。！!]?)$/.test(text)))
}

function explicitlySupportsTerminalState(value, state) {
  const text = compactText(value, 240)
  if (state === "completed") {
    return /(?:做完|弄完|办完|考完|吃完|做好|弄好|办好|完成|结束|已经[^。！!?？]{0,12}完)/.test(text)
  }
  if (state === "cancelled") {
    return /(?:取消|不去(?:了)?|不做(?:了)?|改天|作废)/.test(text)
  }
  return false
}

function containsExplicitUpdateFact(value) {
  const text = compactText(value, 240)
  return /(?:还没|没有|没呢|尚未|已经|正在|开始|做完|弄完|完成|结束|取消|不去|改到|推迟|提前|\d|[一二三四五六七八九十两]+点|今天|明天|后天|上午|中午|下午|晚上)/.test(text)
}

function validateContextualExistingUpdate({
  current,
  matched,
  proposal,
  sourceMessage,
  contextualAssistantMessage,
}) {
  const rejected = reason => ({
    accepted: false,
    reason,
    assistantMessageId: contextualAssistantMessage?.id || null,
  })
  if (!matched || !proposal?.matched_event_id) return rejected("not_existing_update")
  if (isTerminalProactiveEventState(matched.state) || matched.attention_status === "closed") {
    return rejected("terminal_not_reopened")
  }
  if (
    contextualAssistantMessage?.role !== "assistant"
    || !contextualAssistantMessage?.id
    || contextualAssistantMessage?.is_immediately_previous !== true
    || !isExplicitAssistantQuestion(contextualAssistantMessage.content)
  ) {
    return rejected("contextual_assistant_not_explicit_question")
  }

  const assistantTime = isoOrNull(contextualAssistantMessage.created_at)
  const userTime = isoOrNull(sourceMessage?.created_at)
  if (assistantTime && userTime && new Date(assistantTime) >= new Date(userTime)) {
    return rejected("contextual_messages_not_adjacent")
  }

  const referentCandidates = current.filter(candidate => (
    isOpenProactiveAttentionCandidate(candidate)
    && sourceSemanticallySupportsEvent({
      sourceContent: contextualAssistantMessage.content,
      eventText: candidate.description,
    })
  ))
  if (
    referentCandidates.length !== 1
    || referentCandidates[0].event_id !== matched.event_id
  ) {
    return rejected("ambiguous_event_match")
  }

  if (!sourceEvidenceIsQuoted(sourceMessage?.content, proposal.source_evidence)) {
    return rejected("contextual_update_missing_user_fact")
  }
  const stateChanged = proposal.state !== matched.state
  const windowChanged = windowsDiffer(proposal.expected_window, matched.expected_window)
  const descriptionChanged = compactText(proposal.description, 180) !== matched.description
  if (
    !stateChanged
    && !windowChanged
    && !descriptionChanged
    && !containsExplicitUpdateFact(proposal.source_evidence)
  ) {
    return rejected("contextual_update_missing_user_fact")
  }

  return {
    accepted: true,
    reason: "accepted_contextual_existing_update",
    assistantMessageId: contextualAssistantMessage.id,
  }
}

function validateMatchedReferent({
  current,
  matched,
  proposal,
  sourceMessage,
  recentUserSourceLedger = [],
}) {
  if (!matched) return { accepted: true, reason: "new_event" }
  if (
    isTerminalProactiveEventState(matched.state)
    || matched.attention_status === "closed"
  ) {
    return { accepted: false, reason: "terminal_not_reopened" }
  }

  const currentText = compactText(sourceMessage?.content, 240)
  const isShortStateUpdate = isTerminalProactiveEventState(proposal?.state)
    && comparableCharacters(currentText).length <= SHORT_UPDATE_MAX_CHARS
  if (!isShortStateUpdate) return { accepted: true, reason: "not_short_terminal_update" }

  const openCandidates = current.filter(isOpenProactiveAttentionCandidate)
  const matchedScore = lexicalReferentScore(currentText, matched.description)
  const strongerCandidate = openCandidates.find(candidate => (
    candidate.event_id !== matched.event_id
    && lexicalReferentScore(currentText, candidate.description) > matchedScore
  ))
  if (strongerCandidate) {
    return { accepted: false, reason: "stronger_recent_event_referent" }
  }
  if (matchedScore >= 2) {
    return { accepted: true, reason: "explicit_description_referent" }
  }

  const ledgerIds = recentUserSourceLedger
    .filter(item => item?.role === "user" && item?.id)
    .map(item => item.id)
  let latestIndex = -1
  const recentCandidates = []
  for (const candidate of openCandidates) {
    const index = Math.max(
      ledgerIds.lastIndexOf(candidate.last_user_update?.message_id),
      ...candidate.source_message_ids.map(id => ledgerIds.lastIndexOf(id))
    )
    if (index > latestIndex) {
      latestIndex = index
      recentCandidates.length = 0
      recentCandidates.push(candidate)
    } else if (index === latestIndex && index >= 0) {
      recentCandidates.push(candidate)
    }
  }

  const messageTime = isoOrNull(sourceMessage?.created_at)
  const matchedUpdateTime = isoOrNull(matched.last_user_update?.created_at)
  const withinReasonableAge = messageTime && matchedUpdateTime
    ? new Date(messageTime).getTime() - new Date(matchedUpdateTime).getTime()
      <= SHORT_UPDATE_MAX_REFERENT_AGE_MS
    : false
  if (
    latestIndex >= 0
    && recentCandidates.length === 1
    && recentCandidates[0].event_id === matched.event_id
    && withinReasonableAge
  ) {
    return { accepted: true, reason: "unique_recent_user_referent" }
  }
  return { accepted: false, reason: "ambiguous_event_match" }
}

export function applyProactiveEventProposal({
  candidates,
  proposal,
  sourceMessage,
  conversationId = null,
  now = () => new Date().toISOString(),
  createEventId = randomUUID,
  candidateSource = "current_user_message",
  recentUserSourceLedger = [],
  contextualAssistantMessage = null,
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
      diagnostics: diagnostic({
        merge_action: "rejected_invalid_source",
        admission_reason: "invalid_source_provenance",
      }),
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

  const referentCheck = validateMatchedReferent({
    current,
    matched,
    proposal,
    sourceMessage,
    recentUserSourceLedger,
  })
  const sourceSupportsProposal = sourceSemanticallySupportsEvent({
    sourceContent: sourceMessage.content,
    eventText: description,
    sourceEvidence: proposal.source_evidence,
  })
  const sourceSupportsMatched = matched
    ? sourceSemanticallySupportsEvent({
        sourceContent: sourceMessage.content,
        eventText: matched.description,
        sourceEvidence: proposal.source_evidence,
      })
    : false
  const contextualEvidence = (!sourceSupportsProposal && !sourceSupportsMatched && matched)
    ? validateContextualExistingUpdate({
        current,
        matched,
        proposal,
        sourceMessage,
        contextualAssistantMessage,
      })
    : { accepted: false, reason: null, assistantMessageId: null }
  if (!referentCheck.accepted && !contextualEvidence.accepted) {
    return {
      candidates: current,
      diagnostics: diagnostic({
        event_id: matched?.event_id || null,
        event_state: matched?.state || null,
        merge_action: referentCheck.reason,
        matched_event_id: matched?.event_id || matchedEventId,
        source_message_ids: matched?.source_message_ids || [],
        last_user_update_message_id: matched?.last_user_update?.message_id || null,
        expected_window: matched?.expected_window || { start: null, end: null },
        attention_status: matched?.attention_status || null,
        referent_check: referentCheck.reason,
        contextual_assistant_message_id: contextualEvidence.assistantMessageId,
        contextual_referent_verified: false,
      }),
    }
  }
  const shortTerminalReferent = Boolean(
    matched
    && isTerminalProactiveEventState(state)
    && explicitlySupportsTerminalState(sourceMessage?.content, state)
    && ["unique_recent_user_referent", "explicit_description_referent"]
      .includes(referentCheck.reason)
  )
  const shortContextualTerminalReply = Boolean(
    contextualEvidence.accepted
    && isTerminalProactiveEventState(state)
    && comparableCharacters(sourceMessage?.content).length <= SHORT_UPDATE_MAX_CHARS
    && explicitlySupportsTerminalState(sourceMessage?.content, state)
  )

  if (matched && isTerminalProactiveEventState(state)
    && !shortTerminalReferent && !shortContextualTerminalReply
    && !sourceSupportsProposal && !sourceSupportsMatched) {
    return {
      candidates: current,
      diagnostics: diagnostic({
        event_id: matched.event_id,
        event_state: matched.state,
        merge_action: "unsupported_terminal_transition",
        admission_reason: "unsupported_terminal_transition",
        matched_event_id: matched.event_id,
        source_message_ids: matched.source_message_ids,
        last_user_update_message_id: matched.last_user_update.message_id,
        expected_window: matched.expected_window,
        attention_status: matched.attention_status,
        referent_check: referentCheck.reason,
        contextual_assistant_message_id: contextualEvidence.assistantMessageId,
        contextual_referent_verified: contextualEvidence.accepted,
        identity_source: contextualEvidence.accepted
          ? "assistant_question_existing_event"
          : null,
        fact_source: contextualEvidence.accepted
          ? "current_user_message"
          : null,
      }),
    }
  }

  if (matched && !isTerminalProactiveEventState(state)
    && !sourceSupportsProposal && !sourceSupportsMatched && !contextualEvidence.accepted) {
    return {
      candidates: current,
      diagnostics: diagnostic({
        event_id: matched.event_id,
        event_state: matched.state,
        merge_action: "semantic_source_mismatch",
        admission_reason: "semantic_source_mismatch",
        matched_event_id: matched.event_id,
        source_message_ids: matched.source_message_ids,
        last_user_update_message_id: matched.last_user_update.message_id,
        expected_window: matched.expected_window,
        attention_status: matched.attention_status,
        referent_check: referentCheck.reason,
        contextual_assistant_message_id: contextualEvidence.assistantMessageId,
        contextual_referent_verified: false,
      }),
    }
  }

  if (!matched && !sourceSupportsProposal) {
    const terminalDuplicate = findSimilarTerminalCandidate(current, description)
    const rejectionReason = terminalDuplicate
      ? "duplicate_terminal_recreation"
      : "semantic_source_mismatch"
    return {
      candidates: current,
      diagnostics: diagnostic({
        event_id: terminalDuplicate?.event_id || null,
        event_state: terminalDuplicate?.state || null,
        merge_action: rejectionReason,
        admission_reason: rejectionReason,
        matched_event_id: terminalDuplicate?.event_id || null,
        source_message_ids: terminalDuplicate?.source_message_ids || [],
        last_user_update_message_id: terminalDuplicate?.last_user_update?.message_id || null,
        expected_window: terminalDuplicate?.expected_window || { start: null, end: null },
        attention_status: terminalDuplicate?.attention_status || null,
        referent_check: terminalDuplicate ? "terminal_identity_continuity" : "new_event",
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
      created_at: isoOrNull(sourceMessage.created_at),
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
    && withoutMatched.filter(isOpenProactiveAttentionCandidate).length
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
      referent_check: referentCheck.reason,
      admission_reason: contextualEvidence.accepted
        ? "accepted_contextual_existing_update"
        : matched ? "accepted_existing_update" : "accepted_new_event",
      contextual_assistant_message_id: contextualEvidence.accepted
        ? contextualEvidence.assistantMessageId
        : null,
      contextual_referent_verified: contextualEvidence.accepted,
      identity_source: contextualEvidence.accepted
        ? "assistant_question_existing_event"
        : null,
      fact_source: contextualEvidence.accepted
        ? "current_user_message"
        : null,
    }),
  }
}

export function applyProactiveEventProposals({ candidates, proposals = [], ...options }) {
  let nextCandidates = normalizeProactiveAttentionCandidates(candidates)
  const results = []
  const indexedProposals = proposals.slice(0, 3).map((proposal, index) => ({ proposal, index }))
  const orderedProposals = [
    ...indexedProposals.filter(item => item.proposal?.matched_event_id),
    ...indexedProposals.filter(item => !item.proposal?.matched_event_id),
  ]
  for (const { index, proposal } of orderedProposals) {
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
  results.sort((left, right) => left.index - right.index)
  return { candidates: nextCandidates, diagnostics: results }
}

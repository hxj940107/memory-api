import { normalizeActiveConversationContext } from "./activeConversationContext.js"
import { PROACTIVE_EVENT_STATES } from "./proactiveAttentionCandidates.js"

const MAX_RAW_OUTPUT_SUMMARY_CHARS = 280

function summarizeRawOutput(raw) {
  return String(raw || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_RAW_OUTPUT_SUMMARY_CHARS)
}

function stripTrailingCommas(raw) {
  let result = ""
  let inString = false
  let escaped = false

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (inString) {
      result += character
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      result += character
      continue
    }
    if (character === "," && /^\s*[}\]]/.test(raw.slice(index + 1))) continue
    result += character
  }
  return result
}

function parseStrictOrTrailingCommaJson(raw) {
  try {
    return JSON.parse(raw)
  } catch (strictError) {
    const repaired = stripTrailingCommas(raw)
    if (repaired === raw) throw strictError
    return JSON.parse(repaired)
  }
}

function findBalancedObject(raw, startAt = 0) {
  const start = raw.indexOf("{", startAt)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{") depth += 1
    else if (character === "}") {
      depth -= 1
      if (depth === 0) return raw.slice(start, index + 1)
    }
  }
  return null
}

function extractNamedObject(raw, key) {
  const keyIndex = raw.indexOf(`"${key}"`)
  if (keyIndex < 0) return null
  const colonIndex = raw.indexOf(":", keyIndex + key.length + 2)
  if (colonIndex < 0) return null
  return findBalancedObject(raw, colonIndex + 1)
}

function parseTopLevel(raw) {
  const objectText = findBalancedObject(raw)
  if (!objectText) return { value: null, errorCode: "json_object_missing" }
  try {
    return { value: parseStrictOrTrailingCommaJson(objectText), errorCode: null }
  } catch {
    return { value: null, errorCode: "invalid_top_level_json" }
  }
}

function parseNamedSection(raw, key, topLevelValue) {
  if (topLevelValue && Object.hasOwn(topLevelValue, key)) {
    return { value: topLevelValue[key], errorCode: null }
  }
  const objectText = extractNamedObject(raw, key)
  if (!objectText) return { value: null, errorCode: `${key}_missing` }
  try {
    return { value: parseStrictOrTrailingCommaJson(objectText), errorCode: null }
  } catch {
    return { value: null, errorCode: `${key}_invalid_json` }
  }
}

function validateProposal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value: null, errorCode: "event_proposal_invalid_shape" }
  }
  if (value.action === "none") return { value: { action: "none" }, errorCode: null }
  if (value.action !== "create_or_update") {
    return { value: null, errorCode: "event_proposal_invalid_action" }
  }
  if (!PROACTIVE_EVENT_STATES.includes(value.state)) {
    return { value: null, errorCode: "event_proposal_invalid_state" }
  }
  if (typeof value.description !== "string" || !value.description.trim()) {
    return { value: null, errorCode: "event_proposal_invalid_description" }
  }
  if (
    value.matched_event_id !== null
    && value.matched_event_id !== undefined
    && typeof value.matched_event_id !== "string"
  ) {
    return { value: null, errorCode: "event_proposal_invalid_matched_event_id" }
  }
  if (typeof value.source_message_id !== "string" || !value.source_message_id.trim()) {
    return { value: null, errorCode: "event_proposal_invalid_source_message_id" }
  }
  const window = value.expected_window
  if (!window || typeof window !== "object" || Array.isArray(window)) {
    return { value: null, errorCode: "event_proposal_invalid_window" }
  }
  for (const boundary of ["start", "end"]) {
    if (window[boundary] !== null && typeof window[boundary] !== "string") {
      return { value: null, errorCode: "event_proposal_invalid_window" }
    }
    if (
      typeof window[boundary] === "string"
      && Number.isNaN(new Date(window[boundary]).getTime())
    ) {
      return { value: null, errorCode: "event_proposal_invalid_window" }
    }
  }
  if (
    window.start
    && window.end
    && new Date(window.start).getTime() > new Date(window.end).getTime()
  ) {
    return { value: null, errorCode: "event_proposal_invalid_window" }
  }
  return {
    value: {
      action: "create_or_update",
      matched_event_id: value.matched_event_id || null,
      description: value.description,
      state: value.state,
      expected_window: { start: window.start || null, end: window.end || null },
      source_message_id: value.source_message_id.trim(),
    },
    errorCode: null,
  }
}

export function parseActiveContextJudgeOutput(raw, { finishReason = null } = {}) {
  const text = String(raw || "")
  const topLevel = parseTopLevel(text)
  const activeSection = parseNamedSection(text, "active_context", topLevel.value)
  const proposalSectionValue = topLevel.value?.proactive_event_proposals
  const proposalSectionError = Array.isArray(proposalSectionValue)
    ? null
    : "proactive_event_proposals_invalid_shape"
  const activeContext = normalizeActiveConversationContext(activeSection.value, {
    includeSourceEvidence: true,
  })
  const rawProposals = Array.isArray(proposalSectionValue)
    ? proposalSectionValue.slice(0, 3)
    : []
  const proposalResults = rawProposals.map(validateProposal)
  const proposals = proposalResults.map(result => result.value).filter(Boolean)
  const activeErrorCode = activeContext
    ? null
    : activeSection.errorCode || "active_context_invalid_shape"
  const proposalErrorCode = proposalSectionError
  const truncated = finishReason === "length"
  const parseFailed = Boolean(activeErrorCode || proposalErrorCode || truncated)
  const errorCodes = [
    truncated ? "output_truncated" : null,
    activeErrorCode,
    proposalErrorCode,
  ].filter(Boolean)

  return {
    activeContext,
    proactiveEventProposals: proposals,
    diagnostics: {
      status: parseFailed ? "parse_failed" : "parsed",
      parse_failed: parseFailed,
      error_code: errorCodes.join("+") || null,
      active_context_error_code: activeErrorCode,
      proactive_event_proposal_error_code: proposalErrorCode,
      proposal_count: Array.isArray(proposalSectionValue) ? proposalSectionValue.length : 0,
      parsed_proposal_count: proposals.length,
      proposal_results: proposalResults.map((result, index) => ({
        index,
        action: rawProposals[index]?.action || null,
        matched_event_id: rawProposals[index]?.matched_event_id || null,
        source_message_id: rawProposals[index]?.source_message_id || null,
        admission_result: result.value ? "parsed" : "rejected",
        rejection_reason: result.errorCode,
      })),
      top_level_error_code: topLevel.errorCode,
      finish_reason: finishReason,
      raw_output_summary: parseFailed ? summarizeRawOutput(text) : null,
    },
  }
}
